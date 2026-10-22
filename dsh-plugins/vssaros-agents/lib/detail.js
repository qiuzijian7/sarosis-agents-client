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
import { renderAvatarContent } from './core/iconRender.js';
import { CREATE_CLIENT_JS, CREATE_CSS, renderCreateSection } from './createPage.js';
import { HOME_CLIENT_JS, HOME_CSS, buildHomeData, homePanelsHtml } from './home.js';
import { ACTIVITY_CLIENT_JS, buildActivityItems, buildTimelineItems, timeLabel } from './activity.js';

/** 侧栏名册 → 本页的焦点交接键（同源 localStorage；值 = agentId + 竖线 + 时间戳）。 */
export const FOCUS_KEY = 'vssaros.agents.focus';

/* eslint-disable */
// ↓ 浏览器端（toString 内联）：「映射说明」里的「改为跟随默认」。不引用模块作用域；复用页面主脚本的 note。
// 逐个 POST（不并发：每次都会重扫目录 + 重注册 preset），全部结束后整页刷新（名册 / hero / 琥珀标都要重算）。
function resetModelClient() {
	// 「允许被 subagent 选用」开关（2026-10-20）：写 .agent.md 的 `subagent: true`（只动那一行）。
	window.toggleSubagent = function (btn) {
		var id = btn.getAttribute('data-subagent-toggle');
		var on = btn.getAttribute('data-subagent-on') === '1';
		if (!id) { return; }
		btn.disabled = true;
		fetch('/x/agents/api/agents', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'set-subagent', id: id, enabled: !on }),
		}).then(function (r) {
			return r.json().catch(function () { return {}; }).then(function (j) {
				if (!r.ok) { throw new Error(j.error || ('HTTP ' + r.status)); }
				return j;
			});
		}).then(function (j) {
			note('已保存：' + id + (j.delegatable ? ' 可被 subagent 选用' : ' 不再作为委派目标'));
			// 就地改状态（不整页刷新）：按钮文案 + data 属性
			btn.setAttribute('data-subagent-on', j.delegatable ? '1' : '0');
			btn.textContent = j.delegatable ? '取消' : '允许';
			btn.disabled = false;
		}).catch(function (e) {
			btn.disabled = false;
			note('改委派开关失败：' + e.message);
		});
	};
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
/* 2026-10-22：编辑区页去掉了「AGENTS 21」标题行（用户要求）⇒ 页签条成了 header 第一行，上边距归零 */
header > .seg:first-child { margin-top: 0; }
.seg button { flex: 1; padding: 3px 0; font: inherit; font-size: 12px; color: var(--vscode-descriptionForeground, #999); background: transparent; border: 0; cursor: pointer; }
.seg button + button { border-left: 1px solid var(--vscode-panel-border, #555); }
.seg button.on { background: var(--vscode-button-background, #0e639c); color: #fff; }
/* 群聊页签（2026-10-21 重做）：中间栏**直接承载 DSB v3 三栏群聊页**（/x/agents/group/<id>）。
   为什么用同源 iframe 而不是把 groupPage 内联进来：groupPage 的脚本会挂 window.*（note /
   openNewDialog / closeAll…），内联会与本页的 note() 抢全局 ⇒ iframe 天然隔离 ✓。
   高度用 calc 兜住：iframe 自己没有内容高度，100% 会塌成 0 ⇒ 页面一片空白 ✗。 */
.gpframe { height: calc(100vh - 96px); min-height: 420px; }
.gpframe iframe { display: block; width: 100%; height: 100%; border: 0; background: var(--vscode-editor-background, #1e1e1e); }
/* 群聊签：中间栏就是群聊页 ⇒ 只收掉名册筛选框（它筛的是名册表，群里没有）。
   ⚠ hero 身份条**保留**（名字/模型/能力/统计 = mockup 款 A 的必备块）✓ */
body.gptab .search { display: none; }
/* 「活动」feed（mockup 款 C）与「时间线」（款 D）—— 2026-10-21 补齐 */
.c-feed { font-size: 12px; }
.c-feed .ev { padding: 5px 0; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); display: flex; gap: 7px; align-items: baseline; }
.c-feed .ev:last-child { border-bottom: 0; }
.c-feed .ev .ic { flex: none; }
.c-feed .ev .t { color: var(--vscode-descriptionForeground, #999); font-size: 11px; margin-left: auto; flex: none; }
.d-tl { position: relative; padding-left: 16px; }
.d-tl::before { content: ""; position: absolute; left: 5px; top: 4px; bottom: 4px; width: 1px; background: var(--vscode-panel-border, #3c3c3c); }
.d-ev { position: relative; padding: 0 0 12px; font-size: 12px; }
.d-ev::before { content: ""; position: absolute; left: -14px; top: 4px; width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-button-background, #0078d4); }
.d-ev.done::before { background: var(--vscode-charts-green, #89d185); }
.d-ev.run::before { background: var(--vscode-charts-yellow, #cca700); }
.d-ev.err::before { background: var(--vscode-errorForeground, #f14c4c); }
.d-ev .t { color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
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
/* 只有"说明"、没有"问题"时用中性外观（2026-10-20）：21 个 agent 全正常时别再显示成黄色告警 */
details.note { margin: 10px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.28)); border-radius: 6px; background: transparent; }
details.note > summary { padding: 6px 9px; color: var(--vscode-descriptionForeground, #999); font-size: 12px; cursor: pointer; list-style: none; }
details.note > summary::-webkit-details-marker { display: none; }
details.note .wbody { padding: 0 9px 2px; }
details.note li { margin-bottom: 4px; padding: 3px 0 3px 8px; border-left: 2px solid rgba(128,128,128,.35); color: var(--vscode-descriptionForeground, #999); font-size: 11.5px; }
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
/* 版本对比（2026-10-19）：行级 diff，左行号=历史、右行号=当前 */
#mDiff { margin: 8px 10px 0; }
.dwrap { max-height: 340px; overflow: auto; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-radius: 7px; font: 11px/1.55 ui-monospace, Consolas, monospace; }
.drr { display: flex; gap: 8px; padding: 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.drr .dn { flex: 0 0 34px; text-align: right; color: var(--vscode-descriptionForeground, #888); user-select: none; }
.drr .dt { flex: 1 1 auto; }
.drr.add { background: rgba(78,201,176,.14); }
.drr.del { background: rgba(244,135,113,.14); }
.drr.add .dt::before { content: '+ '; color: #4ec9b0; }
.drr.del .dt::before { content: '- '; color: #f48771; }
/* MEMORY.md 的人工编辑口（2026-10-19，P1-2） */
#mEditText { display: block; width: calc(100% - 20px); margin: 8px 10px 0; min-height: 260px; max-height: 60vh; padding: 8px 10px; box-sizing: border-box; font: 11.5px/1.6 ui-monospace, Consolas, monospace; color: var(--vscode-input-foreground, #ccc); background: var(--vscode-input-background, #2a2a2a); border: 1px solid var(--vscode-input-border, #555); border-radius: 7px; resize: vertical; }
#mEditText:focus { outline: none; border-color: var(--vscode-focusBorder, #0e639c); }
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
		const avatar = '<span class="avatar" style="background:' + avatarColorOf(a.id) + '" data-agent-icon="' + escapeHtml(a.icon ?? '') + '">' + renderAvatarContent(a.icon, a.name.slice(0, 1), { size: 16 }) + '</span>';
		// 委派开关（2026-10-20）：`subagent: true` 才进别的 agent 的「可委派清单」。
		// 内置 agent 的 .agent.md 每次启动重新生成 ⇒ 这里只显示状态，不给按钮（改代码才生效）。
		const subagentCell = a.source === 'builtin'
			? (a.delegatable
				? '可被 subagent 选用 <span class="diag">（内置：开关在 common/builtinAgents.ts）</span>'
				: '不作为委派目标 <span class="diag">（内置：开关在 common/builtinAgents.ts）</span>')
			: (a.delegatable ? '可被 subagent 选用' : '不作为委派目标')
				+ ' <button class="act" data-subagent-toggle="' + escapeHtml(a.id) + '" data-subagent-on="' + (a.delegatable ? '1' : '0') + '"'
				+ ' onclick="toggleSubagent(this)" title="写 .agent.md 的 `subagent: true`（只动这一行，正文不变）">'
				+ (a.delegatable ? '取消' : '允许') + '</button>';
		const facts = '<dl>'
			+ '<dt>preset</dt><dd class="mono">' + escapeHtml(presetId) + '</dd>'
			+ '<dt>定义</dt><dd class="mono">' + escapeHtml(a.file ?? '(未知)') + '</dd>'
			+ '<dt>委派</dt><dd>' + subagentCell + '</dd>'
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
	//
	// ★ 2026-10-20 降噪：以前把 `tools 进 allowlist…`、`subagents: false → …` 这类**说明**也计进
	//   "映射说明 / 问题 N"。结果 21 个 agent 一切正常时，标题写着「问题 23」，看着像出了 23 个事 ✗。
	//   现在分两栏：说明（中性色）与问题（黄色）。只有"问题"才让它看起来像警告。
	const INFO_PREFIXES = ['tools 进 allowlist', 'subagents: false →', '没有 agent 标 `subagent: true`'];
	const isInfo = (text) => INFO_PREFIXES.some((p) => text.includes(p));
	const infoNotes = notes.filter(isInfo);
	const issueNotes = notes.filter((n) => !isInfo(n));
	const issueCount = issueNotes.length + errors.length;
	const problems = (notes.length || errors.length)
		? '<details class="' + (issueCount ? 'warn' : 'note') + '"' + (errors.length ? ' open' : '') + '><summary>映射说明 ' + infoNotes.length
			+ (issueCount ? ' · <b>问题 ' + issueCount + '</b>' : '')
			+ (unmappedIds.length ? ' · ' + unmappedIds.length + ' 个模型未映射，可一键改为跟随默认' : '') + '</summary><div class="wbody">' + bulkReset + '<ul>'
			+ noteItems.join('') + errors.map(t => '<li>' + escapeHtml(t) + '</li>').join('') + '</ul></div></details>'
		: '';
	// 委派专用 preset（`<preset>-assign`）不算"已注册的 Agent"（与本体是同一个 agent，见 core/agents.js）
	const ours = roster.filter(id => id.startsWith('vssaros-') && !/-assign$/.test(id));
	// 页脚：把旧版标题下那长条 diag 行收进来（四个探针锚点挂在这里）
	const footer = '<footer data-vssaros-agents-count="' + summary.count + '" data-vssaros-presets-registered="' + ours.length
		+ '" data-vssaros-roster="' + escapeHtml(roster.join(',')) + '" data-vssaros-agents-root="' + escapeHtml(root) + '">'
		+ '已注册 preset ' + ours.length + ' / 花名册 ' + roster.length + ' · <code>' + escapeHtml(root) + '</code></footer>';

	// 用量页签（P5）：按 agent / 按模型；名册外会话单列「未归属」。口径注释与 mockup 一致。
	const usageRows = (usage?.agents ?? []).map(u => {
		const agent = agents.find(a => a.id === u.agentId);
		const models = u.models.length ? u.models.map(m => escapeHtml(m.ref) + '（' + fmtTokens(m.tokens) + '）').join('<br>') : '—';
		const avatar = agent ? '<span class="avatar" style="background:' + avatarColorOf(agent.id) + '">' + renderAvatarContent(agent.icon, agent.name.slice(0, 1), { size: 16 }) + '</span>' : '';
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
	// 群聊页签（2026-10-21 重做）：**中间栏直接就是 DSB v3 三栏群聊页**
	//   （左 agent 列表 + 群聊列表 / 中聊天 / 右 记忆·演化·版本·分支），路由 /x/agents/group/<id>。
	//   旧实现（2026-10-16 的「左群列表 + 右 transcript + 建群表单」内联面板）已下线：
	//   同一个群聊有两套 UI 必然对不上（用户 2026-10-21 就是"看不到重构后的 UI"）⇒ 只留一套 ✓。
	//   承载方式 = 同源 iframe（见 PAGE_CSS 的 .gpframe 注释）。
	const groupItems = groups?.groups ?? [];
	// 打开工作台默认落在哪个群：第一个群；一个群都没有 ⇒ 打开「新建群」态（页面自带建群弹层 ✓）。
	const groupOpenId = groupItems[0]?.id ?? 'new';
	const groupsSection = '<div id="groups"' + (groupItems.length ? '' : ' hidden') + '><div class="gpframe">'
		+ '<iframe id="gpFrame" title="群聊" src="/x/agents/group/' + escapeHtml(groupOpenId) + '"></iframe>'
		+ '</div></div>';
	// 记忆页签（2026-10-16，二期）：agent 选择器 + 文件列表 + 查看器 + Git 状态/历史。
	// 数据全走 /x/agents/api/memory（服务端只渲染壳）；写口只有「启用 Git / 提交快照」两个 ✓。
	// ⚠ 标题刻意点明"常驻"与"与 AgentMemory 检索库无关"：仓里有两套记忆（本页签 = MEMORY.md
	//   文件常驻前缀；memory_* 工具 = AgentMemory 网关库），用户已经因为同名问过两次
	//   ⇒ 页面必须自己说清，别指望人去看代码（2026-10-20）。
	const memorySection = '<div id="memory" hidden><section class="pad"><h2>记忆 <small>常驻注入：MEMORY.md 的前 N 字符随人设段进 prompt（会话内冻结）· 与 AgentMemory 检索库（memory_* 工具）互不写入</small></h2>'
		+ '<div class="aform"><select id="mAgent" onchange="memoryLoad()">' + agents.map(a => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + '</option>').join('') + '</select>'
		+ '<span class="diag" id="mHint">Git 化可选；提交只能人按按钮（模型没有提交口，只能用文件工具改 MEMORY.md）</span>'
// 演化面板（2026-10-21）：把「时间线 / 逐行 diff / 版本 / 回滚」放到独立编辑区页签里
// （这块要宽度；详情页这里只留"管理动作"）
+ '<button class="act" onclick="memoryOpenEvo()" data-vssaros-mem-evo="1">演化面板（历史 / 版本）</button></div>'
		+ '<div class="membar" id="mBar">…</div>'
		// 注入口径（2026-10-19，P1-2）：用了多少 / 上限多少 / 什么时候生效 —— 三件事一眼可见
		+ '<div class="aform" id="mLimitsRow"><span class="diag" id="mLimits">常驻注入：…</span>'
		+ '<span style="margin-left:auto"></span><button class="act" onclick="memoryImportDraft()" data-vssaros-mem-import="1">从记忆库导入草稿…</button>'
		+ '<button class="act" onclick="memoryLimitsEdit()" data-vssaros-mem-limits-edit="1">改上限与生效方式…</button></div>'
		+ '<div class="aform" id="mLimitsForm" hidden><span class="diag">上限</span><input id="mLimitChars" style="width:90px" inputmode="numeric" />'
		+ '<span class="diag">字符（0 = 关闭；512~20000）· 生效方式</span>'
		+ '<select id="mLimitMode"><option value="session">会话内冻结（推荐：前缀稳定，省 token）</option><option value="live">实时刷新（改完立刻变，但每轮前缀会变）</option></select>'
		+ '<span style="margin-left:auto"></span><button class="act" onclick="memoryLimitsSave()" data-vssaros-mem-limits-save="1">保存</button>'
		+ '<button class="act" onclick="memoryLimitsCancel()">取消</button></div>'
		+ '<div class="memwrap"><div class="memlist" id="mList"><p class="diag">…</p></div>'
		+ '<div class="memview"><div class="mh" id="mTitle">选一个文件</div><pre id="mBody">…</pre></div></div>'
		// MEMORY.md 的人工编辑口（只有它进 prompt，所以只给它开编辑；其它记忆文件是 agent 的工作区）
		+ '<div class="aform" id="mTools" hidden><span class="diag" id="mToolsHint"></span>'
		+ '<span style="margin-left:auto"></span><button class="act" onclick="memoryEditOpen()" data-vssaros-mem-edit="1">编辑这个文件</button></div>'
		+ '<div id="mEditor" hidden><textarea id="mEditText" spellcheck="false" data-vssaros-mem-editor="1"></textarea>'
		+ '<div class="aform"><span class="diag" id="mEditHint"></span><span style="margin-left:auto"></span>'
		+ '<button class="act" onclick="memorySaveText()" data-vssaros-mem-save="1">保存</button>'
		+ '<button class="act" onclick="memoryCancelEdit()">取消</button></div></div>'
		// 版本对比（2026-10-19）：「看这版」只给全文，这里给"和当前差在哪"（行级 + 行号）
		+ '<div id="mDiff" hidden><div class="aform"><span class="diag" id="mDiffHint"></span><span style="margin-left:auto"></span>'
		+ '<button class="act" onclick="memoryDiffClose()" data-vssaros-mem-diff-close="1">关闭对比</button></div>'
		+ '<div class="dwrap" id="mDiffBody" data-vssaros-mem-diff="1"></div></div>'
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
			+ '<span id="hEmoji">' + renderAvatarContent(heroOf.icon, heroOf.name.slice(0, 1), { size: 22 }) + '</span>'
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
	// ★ 2026-10-21：默认落点 = **群聊页**（DSB v3 桌面版的中间栏就是群聊）⇒ 有群时概览签默认收起。
	const homeData = buildHomeData({ agents, sessionRows, assignments, groups });
	const groupFirst = Boolean(groupItems.length);
	const overview = heroOf
		? '<div id="overview"' + (groupFirst ? ' hidden' : '') + ' data-vssaros-home data-home="' + escapeHtml(JSON.stringify(homeData)) + '"><section class="pad">'
			+ '<div class="idstrip"><span class="lbl">身份（.agent.md）</span>'
			+ '<span class="hchip">📄 <span class="idchip" id="ovFile">' + escapeHtml(heroOf.file ?? '（未知）') + '</span></span>'
			+ '<span class="hchip" id="ovMem" style="display:none"></span>'
			+ '<button class="act" onclick="heroSettings()" title="打开该 bot 的 Agent 设置页">打开编辑器</button></div>'
			+ '<div class="home-grid" id="homeGrid">' + homePanelsHtml(homeData[heroOf.id], escapeHtml) + '</div>'
			+ '</section></div>'
		: '<div id="overview"' + (groupFirst ? ' hidden' : '') + '><p class="empty">还没有可用的 agent。</p></div>';
	// ── 「活动」（mockup 款 C：此刻 feed + 待你处理）────────────────────────
	//   跨数据源聚合：委派 / 群回收 / 审批在途 / 会话。纯函数在 lib/activity.js（探针可单测 ✓）。
	const activity = buildActivityItems({ agents, sessionRows, assignments, groups, outbox });
	const activityFeedHtml = activity.items.length
		? activity.items.map(it => '<div class="ev" data-vssaros-act-kind="' + escapeHtml(it.kind) + '">'
			+ '<span class="ic">' + escapeHtml(it.icon) + '</span><span>' + escapeHtml(it.text) + '</span>'
			+ '<span class="t">' + escapeHtml(timeLabel(it.at)) + '</span></div>').join('')
		: '<p class="diag">还没有活动。</p>';
	const activitySection = '<div id="activity" hidden data-act-src="' + escapeHtml(JSON.stringify({
		agents: (agents ?? []).map(a => ({ id: a.id, name: a.name })),
		sessionRows: sessionRows ?? [],
		groups: (groups?.groups ?? []).map(g => ({ id: g.id, name: g.name, mode: g.mode, members: g.members ?? [], transcript: g.transcript ?? [] })),
	})) + '"><section class="pad">'
		+ '<div class="card"><h5>此刻 <span class="note">实时轮询</span></h5>'
		+ '<div class="c-feed" id="actFeed" data-vssaros-activity-feed>' + activityFeedHtml + '</div></div>'
		+ '<div class="card"><h5>待你处理</h5><div class="note" id="actTodo" data-vssaros-activity-todo>'
		+ '审批 ' + activity.todo.approvals + ' 条 · unknown-outcome ' + activity.todo.unknown + ' 条 · 委派 ' + activity.todo.running + ' 在跑</div></div>'
		+ '</section></div>';
	// ── 「时间线」（mockup 款 D：会话/委派/记忆快照串成一条线）──────────────
	//   记忆快照要 Git 提交（当前 agent 的记忆仓库）⇒ 客户端拉 /x/agents/api/memory?agent=… 后追加 ✓。
	const timelineItems = buildTimelineItems({ agentId: heroOf?.id, sessionRows, assignments, groups, memoryLog: [] });
	const timelineRowHtml = it => '<div class="d-ev ' + escapeHtml(it.st) + '" data-vssaros-tl-kind="' + escapeHtml(it.kind) + '"'
		+ (it.sessionId ? ' data-session-id="' + escapeHtml(it.sessionId) + '"' : '')
		+ (it.hash ? ' data-mem-hash="' + escapeHtml(it.hash) + '"' : '') + '>'
		+ '<div>' + escapeHtml(it.title) + '</div><div class="t">' + escapeHtml(it.sub) + '</div></div>';
	const timelineSection = '<div id="timeline" hidden><section class="pad">'
		+ '<div class="d-tl" id="tlBody" data-vssaros-timeline>'
		+ (timelineItems.length ? timelineItems.map(timelineRowHtml).join('') : '<p class="diag">还没有事件。</p>')
		+ '</div></section></div>';
const tabNav = '<nav class="seg"><button id="tabOverview"' + (groupFirst ? '' : ' class="on"') + ' onclick="showTab(\'overview\')">概览</button>'
	// ★ 2026-10-21 补齐（用户选「使用 A」+ 补活动/时间线）：款 C 的「此刻 feed」与款 D 的「时间线」
	+ '<button id="tabActivity" data-vssaros-activity-tab onclick="showTab(\'activity\')">活动</button>'
	+ '<button id="tabTimeline" data-vssaros-timeline-tab onclick="showTab(\'timeline\')">时间线</button>'
	+ '<button id="tabRoster" onclick="showTab(\'roster\')">身份 ' + summary.count + '</button>'
		+ '<button id="tabAssign" data-vssaros-assignments-tab onclick="showTab(\'assignments\')" data-assignments-running="' + (assignments?.running ?? 0) + '">委派 ' + assignmentItems.length + '</button>'
		+ '<button id="tabGrant" data-vssaros-grants-tab onclick="showTab(\'grants\')">授权 ' + templateItems.length + '</button>'
		+ '<button id="tabGroup"' + (groupFirst ? ' class="on"' : '') + ' data-vssaros-groups-tab onclick="showTab(\'groups\')">群聊 ' + groupItems.length + '</button>'
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
		// ── 活动 / 时间线（2026-10-21 补齐 mockup 款 C / 款 D）─────────────
		//   纯函数（buildActivityItems 等）由 lib/activity.js 以 toString 内联进来（ACTIVITY_CLIENT_JS），
		//   这样轮询时能在**页面内**重建 feed，不必重载整页 ✓。
		+ ACTIVITY_CLIENT_JS
		// 活动面板刷新：拉最新的委派 + outbox，用同一套口径重建 feed 与「待你处理」
		+ 'function refreshActivity() {'
		+ 'var pane = document.getElementById("activity");'
		+ 'if (!pane || pane.hidden) { return; }'
		+ 'var src = {};'
		+ 'try { src = JSON.parse(pane.getAttribute("data-act-src") || "{}"); } catch (e) { return; }'
		+ 'Promise.all(['
		+ 'fetch("/x/agents/api/assignments").then(function (r) { return r.ok ? r.json() : null; }),'
		+ 'fetch("/x/agents/api/outbox").then(function (r) { return r.ok ? r.json() : null; })'
		+ ']).then(function (rs) {'
		+ 'var a = buildActivityItems({ agents: src.agents || [], sessionRows: src.sessionRows || [], assignments: rs[0], groups: src.groups || [], outbox: rs[1] });'
		+ 'var feed = document.getElementById("actFeed");'
		+ 'if (feed) {'
		+ 'feed.innerHTML = a.items.length ? a.items.map(function (it) {'
		+ 'return "<div class=\\"ev\\" data-vssaros-act-kind=\\"" + esc(it.kind) + "\\"><span class=\\"ic\\">" + esc(it.icon) + "</span><span>" + esc(it.text) + "</span><span class=\\"t\\">" + esc(timeLabel(it.at)) + "</span></div>";'
		+ '}).join("") : "<p class=\\"diag\\">还没有活动。</p>";'
		+ '}'
		+ 'var todo = document.getElementById("actTodo");'
		+ 'if (todo) { todo.textContent = "审批 " + a.todo.approvals + " 条 · unknown-outcome " + a.todo.unknown + " 条 · 委派 " + a.todo.running + " 在跑"; }'
		+ '}).catch(function () { /* 轮询失败下轮再来 */ });'
		+ '}'
		// 时间线的第三类事件（记忆快照）要 Git 提交 ⇒ 打开签时拉一次当前 agent 的记忆
		+ 'function loadTimelineMemory() {'
		+ 'var body = document.getElementById("tlBody");'
		+ 'if (!body || body.getAttribute("data-mem-loaded") === "1") { return; }'
		+ 'var hero = document.getElementById("hero");'
		+ 'var aid = hero ? hero.getAttribute("data-h-agent") : "";'
		+ 'if (!aid) { return; }'
		+ 'fetch("/x/agents/api/memory?agent=" + encodeURIComponent(aid) + "&versions=1&limit=8")'
		+ '.then(function (r) { return r.ok ? r.json() : null; })'
		+ '.then(function (j) {'
		+ 'if (!j || !j.log || !j.log.length) { body.setAttribute("data-mem-loaded", "1"); return; }'
		+ 'var html = j.log.map(function (c) {'
		+ 'return "<div class=\\"d-ev done\\" data-vssaros-tl-kind=\\"memory\\" data-mem-hash=\\"" + esc(c.hash) + "\\"><div>记忆快照 " + String(c.hash || "").slice(0, 7) + "「" + esc(c.subject) + "」</div><div class=\\"t\\">" + esc(c.date || "") + " · 记忆仓库提交</div></div>";'
		+ '}).join("");'
		+ 'body.insertAdjacentHTML("afterbegin", html);'
		+ 'body.setAttribute("data-mem-loaded", "1");'
		+ '}).catch(function () { /* 拉不到就只显示委派/会话两类 */ });'
		+ '}'
		+ 'function showTab(which) {'
		+ "var panes = ['overview', 'activity', 'timeline', 'roster', 'usage', 'assignments', 'grants', 'groups', 'memory', 'create'];"
		+ "for (var i = 0; i < panes.length; i++) {"
		+ 'var pane = document.getElementById(panes[i]);'
		+ 'if (pane) { pane.hidden = panes[i] !== which; }'
		+ '}'
		// 切到时间线 ⇒ 拉当前 agent 的记忆提交（Git 历史）补进时间线（服务端只能渲委派/会话两类 ✓）
		+ 'if (which === "timeline") { loadTimelineMemory(); }'
		+ 'if (which === "activity") { refreshActivity(); }'
		// 新建向导要整块宽度 ⇒ 打开时收起 hero（hero 讲的是「当前 agent」，新建时没有当前 agent ✓）
		// ★ 2026-10-21：hero **不再**在群聊签下收起 —— 身份条（名字/模型/能力/统计）是 mockup 款 A 的
		//   必备块，收掉后 agents 页看着"空"，用户报"缺少 UI"✗。
		+ "var heroEl = document.getElementById('hero');"
		+ "if (heroEl) { heroEl.hidden = which === 'create'; }"
		// ★ 群聊签：中间栏就是群聊页 ⇒ 只收掉名册筛选框（它筛的是名册表，群里没有）。
		+ "document.body.classList.toggle('gptab', which === 'groups');"
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
		// 图标可能是内联 SVG（`icon: lucide:bot`）⇒ 必须搬 innerHTML，textContent 会把它变成空串
		+ 'if (hEmoji && av) { hEmoji.innerHTML = av.innerHTML; }'
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
		// ── 群聊页签（2026-10-21 重做）：中间栏是 DSB 三栏群聊页（同源 iframe）。
		//   旧的「左群列表 + 右 transcript + 建群表单」内联面板已下线（同一群聊只留一套 UI）。
		//   本页只做三件事：① 记住当前群；② 焦点交接时切 iframe；③ 轮询群数更新签上的计数。
		+ 'var G_SELECTED = ' + JSON.stringify(groupItems[0]?.id ?? '') + ';'
		// 只更签上的计数（群聊本体在 iframe 里自己轮询 /x/agents/api/groups ✓ 不重复拉）
		+ 'function refreshGroups() {'
		+ "return fetch('/x/agents/api/groups').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {"
		+ 'if (!j) { return; }'
		+ "var tab = document.getElementById('tabGroup');"
		+ "if (tab) { tab.textContent = '群聊 ' + (j.groups || []).length; }"
		+ '}).catch(function () { /* 轮询失败下轮再来 */ });'
		+ '}'
		// 切到某个群：改 iframe 的 src（群 id 走路径段 —— 页面自己认这个路由 ✓）
		+ 'function selectGroupById(id) {'
		+ 'if (!id) { return; }'
		+ 'G_SELECTED = id;'
		+ "var fr = document.getElementById('gpFrame');"
		+ "if (fr) { fr.src = '/x/agents/group/' + encodeURIComponent(id); }"
		+ '}'
		// ★ 主题传递：iframe 是**独立文档**，拿不到本页的 --vscode-* 变量 ⇒ 群聊页会退回默认皮
		//   （深色块/浅色块），和 IDE 主题对不上 ✗。这里把本页的变量灌进 iframe 的根元素（同源 ⇒ 可直接写）。
		+ 'var THEME_VARS = ["--vscode-editor-background","--vscode-sideBar-background","--vscode-foreground",'
		+ '"--vscode-descriptionForeground","--vscode-disabledForeground","--vscode-panel-border",'
		+ '"--vscode-editorWidget-border","--vscode-editorWidget-background","--vscode-widget-shadow",'
		+ '"--vscode-input-background","--vscode-input-foreground","--vscode-input-border",'
		+ '"--vscode-button-background","--vscode-button-foreground","--vscode-button-hoverBackground",'
		+ '"--vscode-button-secondaryBackground","--vscode-button-secondaryForeground","--vscode-button-secondaryHoverBackground",'
		+ '"--vscode-list-hoverBackground","--vscode-list-activeSelectionBackground","--vscode-list-activeSelectionForeground",'
		+ '"--vscode-focusBorder","--vscode-textLink-foreground","--vscode-charts-green","--vscode-charts-yellow",'
		+ '"--vscode-editorWarning-foreground","--vscode-errorForeground","--vscode-font-family","--vscode-font-size",'
		+ '"--vscode-editor-font-family","--vscode-editorOverlay-background","--vscode-editorHighlightBackground",'
		+ '"--vscode-diffEditor-insertedTextBackground","--vscode-diffEditor-insertedTextForeground",'
		+ '"--vscode-diffEditor-removedTextBackground","--vscode-diffEditor-removedTextForeground"];'
		+ 'function syncThemeToFrame() {'
		+ "var fr = document.getElementById('gpFrame');"
		+ 'if (!fr) { return; }'
		+ 'var doc = null;'
		+ 'try { doc = fr.contentDocument; } catch (e) { return; }'
		+ 'if (!doc || !doc.documentElement) { return; }'
		+ 'var cs = getComputedStyle(document.documentElement);'
		+ 'for (var i = 0; i < THEME_VARS.length; i++) {'
		+ 'var v = cs.getPropertyValue(THEME_VARS[i]);'
		+ 'if (v) { doc.documentElement.style.setProperty(THEME_VARS[i], v.trim()); }'
		+ '}'
		+ '}'
		+ 'function watchFrameTheme() {'
		+ "var fr = document.getElementById('gpFrame');"
		+ 'if (!fr) { return; }'
		+ 'fr.addEventListener("load", syncThemeToFrame);'
		+ 'syncThemeToFrame();'
		+ 'setTimeout(syncThemeToFrame, 250);'
		+ 'setTimeout(syncThemeToFrame, 900);'
		+ '}'
		// ⚠ 注意：**注释只能写在源码层**（这里），不能拼进页面脚本字符串 ——
		//   拼进去的 `//` 会把同一行后面的代码整行吃掉 ⇒ 花括号不配平 ⇒ 整段脚本解析失败
		//   （页面所有交互静默失效，连报错都难看到）✗。
		//   主题切换（IDE 换配色）后 iframe 里的变量不会自己变 ⇒ 轮询同步（可见时才做，开销可忽略）
		+ 'window.setInterval(function () {'
		+ "var pane = document.getElementById('groups');"
		+ 'if (pane && !pane.hidden) { syncThemeToFrame(); }'
		+ '}, 1200);'
		+ 'watchFrameTheme();'
		+ 'window.setInterval(function () {'
		+ "if (document.hidden) { return; }"
		+ "var pane = document.getElementById('groups');"
		+ 'if (pane && !pane.hidden) { refreshGroups(); }'
		+ "var gp = document.getElementById('grants');"
		+ 'if (gp && !gp.hidden) { refreshOutbox(); }'
		// 活动面板可见 ⇒ 刷新 feed（款 C 的「此刻」要能自己动 ✓）
		+ "var ap = document.getElementById('activity');"
		+ 'if (ap && !ap.hidden) { refreshActivity(); }'
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
		// 注入口径一行（2026-10-19，P1-2）：用了多少 / 上限多少 / 何时生效 / 人设多长
		+ "var lim = document.getElementById('mLimits');"
		+ 'if (lim) {'
		+ 'var L = (j && j.limits) || {}; var U = (j && j.usage) || {};'
		+ 'var capTxt = (L.chars === 0) ? "关闭注入" : ((L.chars || 2048) + " 字符");'
		+ 'var modeTxt = (L.mode === "live") ? "实时生效" : "会话内冻结（新会话生效）";'
		// 运行时对账（2026-10-20）：上面三个数都是「配置上应该怎样」，这里补「实际装配成怎样」——
		// preset 还没按新口径重建时两者会不一致，那是唯一能看见的破绽（否则页面永远一片祥和）。
		+ 'var R = L.runtime || null;'
		+ 'var rtTxt;'
		+ 'if (!R) {'
		+ '  rtTxt = " · 尚未装配（还没有会话挂过这个 preset）";'
		+ '} else {'
		+ '  rtTxt = " · 已装配 " + (R.served || 0) + " 次";'
		+ '  if (R.frozenSessions) { rtTxt += " / 冻结 " + R.frozenSessions + " 个会话"; }'
		+ '  if (R.ready === false) { rtTxt += " · 首次读取未就绪"; }'
		+ '  if (typeof R.chars === "number" && R.chars !== L.chars) {'
		+ '    rtTxt += " · ⚠ 装配口径 " + (R.chars === 0 ? "关闭" : R.chars + " 字符") + "（与上限不一致）";'
		+ '  }'
		+ '}'
		+ 'lim.textContent = "常驻注入：" + (U.chars || 0) + " 字符 / 上限 " + capTxt + " · " + modeTxt'
		+ '  + " · 人设 " + (L.personaChars || 0) + " 字" + rtTxt;'
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
		// 历史每行两个动作（2026-10-19）：看这版（只读全文） / 回滚（覆盖该文件 + 自动快照）
		+ 'log.innerHTML = j.git && j.git.enabled && j.log && j.log.length'
		+ ' ? "<b>提交历史（最近 " + j.log.length + " 条 · 只读 · 可看任一版 / 回滚 MEMORY.md）</b>" + j.log.map(function (l) {'
		+ '   return "<div class=\\"lr\\"><span class=\\"h\\">" + esc(l.hash) + "</span><span>" + esc(l.subject) + "</span>"'
		+ '   + "<span class=\\"t\\">" + esc(l.date) + "</span>"'
		+ '   + "<button class=\\"act\\" data-mem-diff=\\"" + esc(l.hash) + "\\" onclick=\\"memoryDiffRev(this.getAttribute(\'data-mem-diff\'))\\">对比当前</button>"'
		+ '   + "<button class=\\"act\\" data-mem-rev=\\"" + esc(l.hash) + "\\" onclick=\\"memoryShowRev(this.getAttribute(\'data-mem-rev\'))\\">看这版</button>"'
		+ '   + "<button class=\\"act\\" data-mem-restore=\\"" + esc(l.hash) + "\\" onclick=\\"memoryRestoreRev(this.getAttribute(\'data-mem-restore\'))\\">回滚</button>"'
		+ '   + "</div>"; }).join("")'
		+ ' : "";'
		+ '}'
		+ '}'
		// ── 注入口径的编辑（上限 / 模式）＋ MEMORY.md 的人工编辑（2026-10-19，P1-2）──────
		+ 'var M_LIMITS = null;'
		+ 'function memoryPost(body) {'
		+ "return fetch('/x/agents/api/memory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })"
		+ '.then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) {'
		+ "if (!r.ok) { throw new Error(j.error || ('HTTP ' + r.status)); }"
		+ 'return j;'
		+ '}); });'
		+ '}'
		// 从记忆库（AgentMemory 网关）拉一份 MEMORY.md 草稿：只填进编辑框，**不写盘**
		// —— 人删改后按「保存」才落盘，与「提交只能人按」同一条纪律（2026-10-20）。
		+ 'function memoryImportDraft() {'
		+ "var sel = document.getElementById('mAgent'); if (!sel) { return; }"
		+ "memoryPost({ action: 'import-draft', agent: sel.value })"
		+ '.then(function (j) {'
		+ 'if (!j || !j.draft) { note("记忆库里没有可导入的条目（空库不是错误）"); return; }'
		+ "var box = document.getElementById('mEditor');"
		+ "var ta = document.getElementById('mEditText');"
		+ "var hint = document.getElementById('mEditHint');"
		+ 'if (!box || !ta) { return; }'
		+ 'ta.value = j.draft;'
		+ 'if (hint) {'
		+ 'hint.textContent = "草稿：来自记忆库 " + (j.count || 0) + " 条"'
		+ '  + (j.truncated ? "（已截断到上限）" : "") + " · 未保存，删改后按「保存」";'
		+ '}'
		+ 'box.hidden = false;'
		+ '}).catch(function (e) { note("从记忆库导入失败：" + e.message); });'
		+ '}'
		+ 'function memoryLimitsEdit() {'
		+ 'memoryApi("").then(function (j) {'
		+ 'M_LIMITS = (j && j.limits) || null;'
		+ "var box = document.getElementById('mLimitsForm');"
		+ "var ch = document.getElementById('mLimitChars');"
		+ "var md = document.getElementById('mLimitMode');"
		+ 'if (!box || !ch || !md) { return; }'
		+ 'ch.value = String(M_LIMITS && M_LIMITS.chars !== undefined ? M_LIMITS.chars : 2048);'
		+ "md.value = (M_LIMITS && M_LIMITS.mode === 'live') ? 'live' : 'session';"
		+ 'box.hidden = false;'
		+ '}).catch(function (e) { note("读注入口径失败：" + e.message); });'
		+ '}'
		+ 'function memoryLimitsCancel() {'
		+ "var b = document.getElementById('mLimitsForm'); if (b) { b.hidden = true; }"
		+ '}'
		+ 'function memoryLimitsSave() {'
		+ "var sel = document.getElementById('mAgent'); if (!sel) { return; }"
		+ "var ch = document.getElementById('mLimitChars'); var md = document.getElementById('mLimitMode');"
		+ 'var chars = Number(ch && ch.value); var mode = md ? md.value : "session";'
		+ "if (!isFinite(chars)) { note('上限要是数字'); return; }"
		+ "memoryPost({ action: 'set-limits', agent: sel.value, chars: chars, mode: mode })"
		+ '.then(function (j) {'
		+ "note('已保存：上限 ' + (j.chars === 0 ? '关闭' : j.chars + ' 字符') + ' · ' + (j.mode === 'live' ? '实时生效' : '会话内冻结'));"
		+ 'memoryLimitsCancel(); memoryLoad();'
		+ '}).catch(function (e) { note("保存注入口径失败：" + e.message); });'
		+ '}'
		+ 'function memoryEditOpen() {'
		+ "if (M_FILE !== 'MEMORY.md') { note('只支持在页面里编辑 MEMORY.md（人设请改 .agent.md 正文）'); return; }"
		+ 'memoryApi("&file=" + encodeURIComponent(M_FILE)).then(function (j) {'
		+ "var box = document.getElementById('mEditor');"
		+ "var ta = document.getElementById('mEditText');"
		+ "var hint = document.getElementById('mEditHint');"
		+ 'if (!box || !ta) { return; }'
		+ 'ta.value = (j && j.content && j.content.text) ? j.content.text : "";'
		+ 'if (hint) {'
		+ 'var L = (j && j.limits) || {};'
		+ 'hint.textContent = "上限 " + (L.chars === 0 ? "关闭" : (L.chars || 2048) + " 字符") + " · "'
		+ '  + (L.mode === "live" ? "保存后立刻生效" : "保存后在新会话生效（本会话已冻结）");'
		+ '}'
		+ 'box.hidden = false;'
		+ '}).catch(function (e) { note("读取失败：" + e.message); });'
		+ '}'
		+ 'function memoryCancelEdit() {'
		+ "var b = document.getElementById('mEditor'); if (b) { b.hidden = true; }"
		+ '}'
		+ 'function memorySaveText() {'
		+ "var sel = document.getElementById('mAgent'); var ta = document.getElementById('mEditText');"
		+ 'if (!sel || !ta) { return; }'
		+ "memoryPost({ action: 'write-memory', agent: sel.value, text: ta.value })"
		+ '.then(function (j) {'
		+ "note('已保存 MEMORY.md（' + j.chars + ' 字符）');"
		+ 'memoryCancelEdit(); memoryLoad();'
		+ "if (M_FILE === 'MEMORY.md') { memoryView({ getAttribute: function () { return 'MEMORY.md'; } }); }"
		+ '}).catch(function (e) { note("保存失败：" + e.message); });'
		+ '}'
		// 版本对比（2026-10-19）：服务端算行级 diff（左 = 历史版本，右 = 当前工作区）
		+ 'function memoryDiffRev(hash) {'
		+ "var sel = document.getElementById('mAgent'); if (!sel) { return; }"
		+ "var file = M_FILE || 'MEMORY.md';"
		+ "fetch('/x/agents/api/memory?agent=' + encodeURIComponent(sel.value) + '&file=' + encodeURIComponent(file) + '&rev=' + encodeURIComponent(hash) + '&against=working')"
		+ '.then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { throw new Error(j.error || ("HTTP " + r.status)); } return j; }); })'
		+ '.then(function (j) {'
		+ 'var d = j.diff;'
		+ "var box = document.getElementById('mDiffBody');"
		+ "var hint = document.getElementById('mDiffHint');"
		+ "var pane = document.getElementById('mDiff');"
		+ 'if (!d || !box || !pane) { note("没有对比数据"); return; }'
		+ 'if (hint) {'
		+ 'hint.textContent = "历史 " + String(hash).slice(0, 7) + " → 当前 · +" + d.added + " / -" + d.removed'
		+ '  + (d.coarse ? "（差异过大，已退化为整块对比）" : "") + " · 共 " + d.rows.length + " 行";'
		+ '}'
		+ 'var html = "";'
		+ 'for (var i = 0; i < d.rows.length; i++) {'
		+ 'var r = d.rows[i];'
		+ 'html += "<div class=\\"drr " + r.type + "\\"><span class=\\"dn\\">" + (r.a === null ? "" : r.a) + "</span><span class=\\"dn\\">" + (r.b === null ? "" : r.b) + "</span><span class=\\"dt\\">" + esc(r.text) + "</span></div>";'
		+ '}'
		+ 'box.innerHTML = html || "<div class=\\"drr same\\"><span class=\\"dt\\">（两版内容一致）</span></div>";'
		+ 'pane.hidden = false;'
		+ '}).catch(function (e) { note("对比失败：" + e.message); });'
		+ '}'
		+ 'function memoryDiffClose() {'
		+ "var p = document.getElementById('mDiff'); if (p) { p.hidden = true; }"
		+ '}'
		// 历史版本：看全文 / 回滚（2026-10-19）
		+ 'function memoryShowRev(hash) {'
		+ "var sel = document.getElementById('mAgent'); if (!sel) { return; }"
		+ "var file = M_FILE || 'MEMORY.md';"
		+ "fetch('/x/agents/api/memory?agent=' + encodeURIComponent(sel.value) + '&file=' + encodeURIComponent(file) + '&rev=' + encodeURIComponent(hash))"
		+ '.then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { throw new Error(j.error || ("HTTP " + r.status)); } return j; }); })'
		+ '.then(function (j) {'
		+ "var t = document.getElementById('mTitle'); var b = document.getElementById('mBody');"
		+ "if (t) { t.textContent = file + ' @ ' + String(hash).slice(0, 7) + '（历史版本 · 只读）'; }"
		+ "if (b) { b.textContent = (j.content && j.content.text) ? j.content.text : '（读不到）'; }"
		+ '}).catch(function (e) { note("读历史版本失败：" + e.message); });'
		+ '}'
		+ 'function memoryRestoreRev(hash) {'
		+ "var sel = document.getElementById('mAgent'); if (!sel) { return; }"
		+ "var file = M_FILE || 'MEMORY.md';"
		+ "if (!window.confirm('把 ' + file + ' 回滚到 ' + String(hash).slice(0, 7) + ' 的内容？\\n会覆盖当前文件，并自动记一条快照。')) { return; }"
		+ "memoryPost({ action: 'restore', agent: sel.value, file: file, rev: hash })"
		+ '.then(function (j) {'
		+ "note('已回滚 ' + j.name + ' 到 ' + j.rev + (j.snapshot && j.snapshot.committed ? '（已提交快照）' : ''));"
		+ 'memoryLoad();'
		+ "if (M_FILE === 'MEMORY.md') { memoryView({ getAttribute: function () { return 'MEMORY.md'; } }); }"
		+ '}).catch(function (e) { note("回滚失败：" + e.message); });'
		+ '}'
		// 演化面板入口（2026-10-21）：开成独立编辑区页签，按 agent 各自一个 tab
	// （`openModulePage` 的路径段 ⇒ 单例键 = 容器 + 子路由）。
	+ 'window.memoryOpenEvo = function () {'
	+ "var sel = document.getElementById('mAgent');"
	+ "var id = sel && sel.value ? sel.value : '';"
	+ "if (!id) { note('先选一个 agent'); return; }"
	+ 'var bridge = window.vssarosDsh;'
	+ "if (!bridge || typeof bridge.openModulePage !== 'function') { note('当前宿主不支持在编辑区打开（需要桥版本 3+）'); return; }"
	+ "try { bridge.openModulePage('/x/agents/memory/' + id); } catch (e) { note('打开演化面板失败：' + e); }"
	+ '};'
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
		// 只有 MEMORY.md 进 prompt ⇒ 只有它开"页面内编辑"（其它记忆文件是 agent 的工作区）
		+ "var tools = document.getElementById('mTools');"
		+ "var th = document.getElementById('mToolsHint');"
		+ "if (tools) { tools.hidden = name !== 'MEMORY.md'; }"
		+ "if (th) { th.textContent = name === 'MEMORY.md' ? '这是会进 prompt 的常驻记忆（保存后按上面的生效方式生效）' : ''; }"
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
<body data-vssaros-page="agents" data-vssaros-surface="editor"${groupFirst ? ' class="gptab"' : ''}>
<header>
	${tabNav}
	<button class="act" onclick="showTab('create'); if (window.crBegin) { crBegin('blank'); }" title="新建一个 Agent（写入 .agent.md）">＋ 新建</button>
	<label class="search"><span class="mag">⌕</span><input id="q" placeholder="筛选 name / id / 描述" oninput="filterRows()"><span class="n" id="qCount">${summary.count}</span></label>
</header>
<p class="diag note" id="pageNote" hidden></p>
${hero}
${overview}
${activitySection}
${timelineSection}
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
