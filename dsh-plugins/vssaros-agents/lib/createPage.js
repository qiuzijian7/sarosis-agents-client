// @vssaros/dsh-agents — 新建 Agent 向导（编辑区完整页里的一个视图，2026-10-16，方案 A / Q8 = 编辑区页签）。
//
// 入口：侧栏「＋ 新建」菜单 / 名册底部虚线行 / 空名册引导 / 编辑区标题栏按钮 ⇒ 都汇到这里：
//   侧栏 → 焦点交接 'create:<起点>'（detail.js 的 applyFocus 认这个前缀）→ showTab('create') + crBegin(起点)。
// 三步：① 起点（空白 / 复制已有 / 导入 .agent.md）→ ② 填写 + 实时预览（每次输入请求 api/agents validate，
//   预览里的原文就是落盘的那份 ✓）→ ③ 完成（打开对话 = 桥 newChat；Agent 设置 = 桥 openAgentSettings）。
//
// ⚠ 浏览器脚本写成**真函数**再 toString() 内联：不进任何模板串、不做手工转义 ⇒ 反引号 / 反斜杠都安全
//   （本仓「模板串里的浏览器载荷被吃一层转义」踩过多次 ✓）。函数体里**不许引用本模块的任何变量**
//   （它在浏览器里跑），也不许出现脚本结束标签的字面量。
// ⚠ 数据走元素的 data-create 属性（HTML 转义的 JSON），**不另起 script 标签** —— p3-06 的「页内脚本整段可解析」
//   检查按第一个到最后一个 script 标签整段取，多一个 JSON 块会把它打红。

import { escapeHtml } from './core/agents.js';

/** 可选图标（与 IDE 原生新建页的 ICON_OPTIONS 同一批，挑常用的）。 */
const ICONS = ['🤖', '👨‍💻', '🔬', '✍️', '🎨', '📋', '🧪', '🚀', '📊', '🧭', '📚', '🧠', '🔧', '🐛', '🔍', '💡', '🎯', '🛠', '☁️', '🔒'];

export const CREATE_CSS = `
/* hero 自带 display:flex ⇒ 会压过浏览器对 hidden 属性的默认样式（showTab('create') 收起 hero 实测无效 ✗ p3-96 抓到）
   向导内部同理：凡是靠 hidden 切换的块都显式兜一层 */
#hero[hidden], #create [hidden] { display: none !important; }
#create .cr { max-width: 1100px; }
.cr-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.cr-head h2 { margin: 0; font-size: 14px; }
.cr-steps { display: flex; gap: 4px; font-size: 11px; }
.cr-steps span { padding: 1px 9px; border-radius: 9px; border: 1px solid var(--vscode-panel-border, #555); color: var(--vscode-descriptionForeground, #999); }
.cr-steps span.on { background: var(--vscode-button-background, #0e639c); border-color: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
.cr-steps span.past { color: #4ec9b0; border-color: #2c4a43; }
.cr-starts { display: grid; grid-template-columns: repeat(3, minmax(0, 220px)); gap: 9px; margin-bottom: 12px; }
.cr-card { border: 1px solid var(--vscode-panel-border, #555); border-radius: 9px; padding: 10px 12px; cursor: pointer; background: rgba(128,128,128,.05); }
.cr-card:hover, .cr-card.on { border-color: var(--vscode-focusBorder, #0e639c); }
.cr-card b { display: block; margin-bottom: 3px; }
.cr-card small { color: var(--vscode-descriptionForeground, #999); }
.cr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 7px; }
.cr-tpl { display: flex; gap: 8px; align-items: center; border: 1px solid var(--vscode-panel-border, #555); border-radius: 8px; padding: 6px 9px; cursor: pointer; min-width: 0; }
.cr-tpl:hover { border-color: var(--vscode-focusBorder, #0e639c); }
.cr-tpl .t { min-width: 0; overflow: hidden; }
.cr-tpl .t div, .cr-tpl .t small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cr-tpl small { color: var(--vscode-descriptionForeground, #999); font-size: 10.5px; }
.cr-av { flex: none; width: 28px; height: 28px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 14px; }
.cr-body { display: flex; gap: 14px; align-items: flex-start; }
.cr-form { flex: 1 1 55%; min-width: 0; }
.cr-prev { flex: 1 1 45%; min-width: 0; position: sticky; top: 46px; }
.cr-fl { margin-bottom: 10px; }
.cr-fl > label { display: block; font-size: 11px; color: var(--vscode-descriptionForeground, #999); margin-bottom: 3px; }
.cr-fl > label i { color: #f48771; font-style: normal; }
.cr-fl input, .cr-fl textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background, #2a2a2a); color: var(--vscode-input-foreground, #ccc); border: 1px solid var(--vscode-input-border, #555); border-radius: 5px; padding: 4px 8px; font: inherit; }
.cr-fl input:focus, .cr-fl textarea:focus { outline: none; border-color: var(--vscode-focusBorder, #0e639c); }
.cr-fl textarea { min-height: 120px; resize: vertical; font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }
.cr-fl .hint { font-size: 10.5px; color: var(--vscode-descriptionForeground, #999); margin-top: 2px; }
.cr-row2 { display: flex; gap: 10px; }
.cr-row2 > .cr-fl { flex: 1; min-width: 0; }
.cr-icons { display: flex; flex-wrap: wrap; gap: 3px; }
.cr-icons span { width: 26px; height: 26px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; border: 1px solid transparent; }
.cr-icons span:hover { background: rgba(128,128,128,.15); }
.cr-icons span.on { border-color: var(--vscode-focusBorder, #0e639c); }
.cr-pp { display: flex; gap: 4px; margin-bottom: 5px; }
.cr-pp button, .cr-foot button, .cr-done button, .cr-head button { font-size: 11.5px; padding: 3px 11px; border-radius: 5px; cursor: pointer; border: 1px solid var(--vscode-panel-border, #555); background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-foreground, #ccc); }
.cr-foot button.primary, .cr-done button.primary { background: var(--vscode-button-background, #0e639c); border-color: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
.cr-foot button[disabled] { opacity: .45; cursor: not-allowed; }
.cr-foot { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); }
.cr-foot .sp { flex: 1; }
.cr-foot .path { font-size: 10.5px; color: var(--vscode-descriptionForeground, #999); overflow-wrap: anywhere; }
.cr-valid div { font-size: 11px; padding: 1px 0; }
.cr-valid .e { color: #f48771; } .cr-valid .w { color: #cca700; } .cr-valid .o { color: #4ec9b0; }
.cr-src { font: 11px/1.6 ui-monospace, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(128,128,128,.08); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 7px; padding: 8px 10px; max-height: 340px; overflow: auto; }
.cr-plabel { font-size: 10.5px; color: var(--vscode-descriptionForeground, #999); margin: 0 0 5px; }
.cr-pcard { display: flex; gap: 8px; align-items: center; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 8px; padding: 7px 9px; margin-bottom: 12px; max-width: 300px; }
.cr-pcard .n { font-weight: 600; } .cr-pcard .r { font-size: 10px; color: #c586c0; margin-left: 5px; }
.cr-pcard .d { font-size: 11px; color: var(--vscode-descriptionForeground, #999); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cr-new { font-size: 9px; padding: 0 5px; border-radius: 6px; background: #4ec9b0; color: #111; margin-left: 5px; }
.cr-import textarea { width: 100%; box-sizing: border-box; min-height: 180px; font: 11.5px/1.5 ui-monospace, Consolas, monospace; background: var(--vscode-input-background, #2a2a2a); color: var(--vscode-input-foreground, #ccc); border: 1px solid var(--vscode-input-border, #555); border-radius: 6px; padding: 8px; }
.cr-done { text-align: center; padding: 28px 10px; }
.cr-done .ok { font-size: 34px; color: #4ec9b0; }
.cr-done .ln { font-size: 12px; margin: 4px 0; }
.cr-done code { background: rgba(128,128,128,.15); border-radius: 4px; padding: 0 5px; overflow-wrap: anywhere; }
.cr-done .acts { display: flex; gap: 8px; justify-content: center; margin-top: 14px; flex-wrap: wrap; }
.cr-err { color: #f48771; font-size: 11.5px; margin: 6px 0; }
.cr-section { font-size: 11px; color: var(--vscode-descriptionForeground, #999); margin: 12px 0 6px; }`;

/**
 * 向导区块（默认隐藏；showTab('create') 才显示）。
 * @param input.agents 已有 agent（「复制已有」的列表 + 人格原文）
 * @param input.create { modelCandidates, hasDefaultProvider }
 */
export function renderCreateSection({ agents, create }) {
	const data = {
		agents: (agents ?? []).map(a => ({
			id: a.id, name: a.name, description: a.description ?? '', icon: a.icon ?? '', role: a.role ?? '', model: a.model ?? '',
			skills: a.skills ?? [], tools: a.tools ?? [], persona: (a.persona ?? '').slice(0, 20000),
			workspacesRead: a.workspaces?.read ?? [], workspacesWrite: a.workspaces?.write ?? [],
		})),
		models: create?.modelCandidates ?? [],
		hasDefaultProvider: create?.hasDefaultProvider === true,
		icons: ICONS,
	};
	return '<div id="create" hidden data-vssaros-create data-create="' + escapeHtml(JSON.stringify(data)) + '"><section class="pad cr">'
		+ '<div class="cr-head"><h2>新建 Agent</h2><div class="cr-steps"><span id="crS1" class="on">① 起点</span><span id="crS2">② 填写</span><span id="crS3">③ 完成</span></div>'
		+ '<span style="flex:1"></span><button onclick="crCancel()">取消</button></div>'
		+ '<div id="crStep1">'
		+ '<div class="cr-starts">'
		+ '<div class="cr-card" data-cr-start="blank" onclick="crBegin(\'blank\')"><b>✎ 空白创建</b><small>从零填写名称、人格、模型</small></div>'
		+ '<div class="cr-card" data-cr-start="copy" onclick="crBegin(\'copy\')"><b>❏ 复制已有 Agent</b><small>在一个现成的基础上改</small></div>'
		+ '<div class="cr-card" data-cr-start="import" onclick="crBegin(\'import\')"><b>⇪ 导入 .agent.md</b><small>粘贴别处的定义原文</small></div>'
		+ '</div>'
		+ '<div id="crCopy" hidden><div class="cr-section">选一个复制（会生成「名称 副本」，原来那个不受影响）</div><div class="cr-grid" id="crCopyList"></div></div>'
		+ '<div id="crImport" class="cr-import" hidden><div class="cr-section">粘贴 .agent.md 原文（--- 开头的 frontmatter，然后是人格正文）</div>'
		+ '<textarea id="crImportText" placeholder="---&#10;name: 代码评审员&#10;description: 只做评审，不改代码&#10;---&#10;# 评审守则"></textarea>'
		+ '<div class="cr-err" id="crImportErr" hidden></div><div class="cr-foot"><span class="sp"></span><button class="primary" onclick="crImport()">解析并继续 →</button></div></div>'
		+ '</div>'
		+ '<div id="crStep2" hidden><div class="cr-body"><div class="cr-form">'
		+ '<div class="cr-section" id="crFrom" hidden></div>'
		+ '<div class="cr-row2"><div class="cr-fl"><label>名称 <i>*</i></label><input id="crName" data-cr="name" placeholder="比如：代码评审员"></div>'
		+ '<div class="cr-fl"><label>id（= 目录名）</label><input id="crId" data-cr="id" placeholder="code-reviewer"><div class="hint">默认按名称生成；名称没有英文时需要手动起一个</div></div></div>'
		+ '<div class="cr-fl"><label>图标</label><div class="cr-icons" id="crIcons"></div></div>'
		+ '<div class="cr-row2"><div class="cr-fl"><label>角色（role · 名册里的紫色小标签）</label><input data-cr="role" placeholder="评审 / 检索 / 工程"></div>'
		+ '<div class="cr-fl"><label>模型</label><input data-cr="model" list="crModels" placeholder="留空 = 跟随默认模型"><datalist id="crModels"></datalist><div class="hint" id="crModelHint"></div></div></div>'
		+ '<div class="cr-fl"><label>简介（description · 名册副行用它）</label><input data-cr="description" placeholder="一句话说明它干什么"></div>'
		+ '<div class="cr-fl"><label>人格（写进 .agent.md 正文）</label><div class="cr-pp"><button onclick="crPersona(\'blank\')">空白</button><button onclick="crPersona(\'colleague\')">同事</button><button onclick="crPersona(\'roleplay\')">角色扮演</button></div>'
		+ '<textarea data-cr="persona" placeholder="人格正文（Markdown）"></textarea></div>'
		+ '<div class="cr-row2"><div class="cr-fl"><label>技能（skills，逗号分隔）</label><input data-cr="skills" placeholder="anysearch, docx"></div>'
		+ '<div class="cr-fl"><label>工具（tools，逗号分隔）</label><input data-cr="tools" placeholder="留空 = 不限；如 read, grep"></div></div>'
		+ '<details><summary style="cursor:pointer;font-size:11px;color:var(--vscode-descriptionForeground,#999)">进阶：工作区授权</summary>'
		+ '<div class="cr-fl" style="margin-top:6px"><label>可读工作区（workspaces-read，绝对路径，逗号分隔；不写 = 只允许默认 cwd）</label><input data-cr="workspacesRead"></div>'
		+ '<div class="cr-fl"><label>可写工作区（workspaces-write，自动并入可读）</label><input data-cr="workspacesWrite"></div></details>'
		+ '</div><div class="cr-prev">'
		+ '<div class="cr-plabel">名册里的样子</div><div class="cr-pcard" id="crCard"></div>'
		+ '<div class="cr-plabel">校验</div><div class="cr-valid" id="crValid"></div>'
		+ '<div class="cr-plabel" style="margin-top:10px">.agent.md 原文（就是落盘的那份）</div><div class="cr-src" id="crSrc"></div>'
		+ '</div></div>'
		+ '<div class="cr-foot"><button onclick="crBack()">← 上一步</button><span class="sp"></span><span class="path" id="crPath"></span>'
		+ '<button class="primary" id="crCreate" disabled onclick="crCreate()">创建 Agent</button></div></div>'
		+ '<div id="crStep3" hidden><div class="cr-done"><div class="ok">✓</div><h2 id="crDoneName" style="font-size:15px"></h2>'
		+ '<div class="ln" id="crDoneFile"></div><div class="ln" id="crDoneReg"></div>'
		+ '<div class="acts"><button class="primary" onclick="crOpenChat()">打开对话</button><button onclick="crSettings()">Agent 设置</button><button onclick="crAgain()">再建一个</button><button onclick="crRefresh()">回到名册</button></div></div></div>'
		+ '</section></div>';
}

/* eslint-disable */
// ↓ 浏览器端（toString 内联）。只用 ES2017 语法；不引用模块作用域。
function createClient() {
	var root = document.getElementById('create');
	if (!root) { return; }
	var DATA = {};
	try { DATA = JSON.parse(root.getAttribute('data-create') || '{}'); } catch (e) { DATA = {}; }
	var NL = String.fromCharCode(10);
	var draft = {};
	var idEdited = false;
	var created = null;
	var timer = 0;
	var seq = 0;
	var $ = function (id) { return document.getElementById(id); };
	var escH = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
	var say = function (t) { if (typeof note === 'function') { note(t); } };
	var colorOf = function (id) { var h = 0; var s = String(id || ''); for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; } return 'hsl(' + (h % 360) + ' 45% 42%)'; };
	var slug = function (n) { return String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64); };
	var blank = function () { return { name: '', id: '', icon: '🤖', role: '', description: '', model: '', persona: '', skills: '', tools: '', workspacesRead: '', workspacesWrite: '' }; };
	function step(n) {
		$('crStep1').hidden = n !== 1; $('crStep2').hidden = n !== 2; $('crStep3').hidden = n !== 3;
		for (var i = 1; i <= 3; i++) { var s = $('crS' + i); s.className = i === n ? 'on' : (i < n ? 'past' : ''); }
	}
	function fill() {
		var els = root.querySelectorAll('[data-cr]');
		for (var i = 0; i < els.length; i++) { var k = els[i].getAttribute('data-cr'); els[i].value = draft[k] == null ? '' : (Array.isArray(draft[k]) ? draft[k].join(', ') : draft[k]); }
		renderIcons();
	}
	function renderIcons() {
		var box = $('crIcons'); var html = '';
		var icons = DATA.icons || [];
		for (var i = 0; i < icons.length; i++) { html += '<span data-cr-icon="' + escH(icons[i]) + '" class="' + (draft.icon === icons[i] ? 'on' : '') + '">' + escH(icons[i]) + '</span>'; }
		box.innerHTML = html;
	}
	function toForm(d, from) {
		draft = d; idEdited = !!d.id && d.id !== slug(d.name);
		var f = $('crFrom'); f.hidden = !from; f.textContent = from || '';
		fill(); step(2); validate();
		var n = $('crName'); if (n) { n.focus(); }
	}
	window.crBegin = function (start) {
		created = null;
		var cards = root.querySelectorAll('[data-cr-start]');
		for (var i = 0; i < cards.length; i++) { cards[i].classList.toggle('on', cards[i].getAttribute('data-cr-start') === start); }
		$('crCopy').hidden = start !== 'copy'; $('crImport').hidden = start !== 'import';
		if (start === 'blank') { toForm(blank(), ''); return; }
		step(1);
		if (start === 'copy') {
			var list = DATA.agents || []; var html = '';
			for (var j = 0; j < list.length; j++) {
				var a = list[j];
				html += '<div class="cr-tpl" data-cr-copy="' + escH(a.id) + '"><span class="cr-av" style="background:' + colorOf(a.id) + '">' + escH(a.icon || a.name.slice(0, 1)) + '</span>'
					+ '<div class="t"><div>' + escH(a.name) + '</div><small>' + escH(a.description || a.id) + '</small></div></div>';
			}
			$('crCopyList').innerHTML = html || '<span class="hint">名册是空的，先用「空白创建」吧</span>';
		}
		if (start === 'import') { var t = $('crImportText'); if (t) { t.focus(); } }
	};
	root.addEventListener('click', function (e) {
		var ic = e.target.closest ? e.target.closest('[data-cr-icon]') : null;
		if (ic) { draft.icon = ic.getAttribute('data-cr-icon'); renderIcons(); validate(); return; }
		var cp = e.target.closest ? e.target.closest('[data-cr-copy]') : null;
		if (cp) {
			var id = cp.getAttribute('data-cr-copy'); var list = DATA.agents || []; var a = null;
			for (var i = 0; i < list.length; i++) { if (list[i].id === id) { a = list[i]; } }
			if (!a) { return; }
			var d = blank();
			d.name = a.name + ' 副本'; d.id = a.id + '-copy'; d.icon = a.icon || '🤖'; d.role = a.role; d.description = a.description; d.model = a.model;
			d.persona = a.persona; d.skills = a.skills.join(', '); d.tools = a.tools.join(', ');
			d.workspacesRead = a.workspacesRead.join(', '); d.workspacesWrite = a.workspacesWrite.join(', ');
			toForm(d, '复制自 ' + a.name + '（原来那个不受影响）');
		}
	});
	root.addEventListener('input', function (e) {
		var k = e.target.getAttribute ? e.target.getAttribute('data-cr') : null;
		if (!k) { return; }
		draft[k] = e.target.value;
		if (k === 'id') { idEdited = true; }
		if (k === 'name' && !idEdited) { draft.id = slug(draft.name); var idEl = $('crId'); if (idEl) { idEl.value = draft.id; } }
		clearTimeout(timer); timer = setTimeout(validate, 200);
		renderCard();
	});
	window.crPersona = function (kind) {
		if (kind === 'colleague') { draft.persona = ['# ' + (draft.name || '新同事'), '你是团队里的一名同事，负责：' + (draft.description || '（写清楚职责）') + '。', '- 先确认目标，再动手', '- 不确定就问，不要猜'].join(NL); }
		else if (kind === 'roleplay') { draft.persona = ['# ' + (draft.name || '角色'), '你在扮演：' + (draft.role || '（写清楚角色）') + '。保持人设，用第一人称说话。'].join(NL); }
		else { draft.persona = ''; }
		fill(); validate();
	};
	function renderCard() {
		var id = draft.id || 'new-agent';
		$('crCard').innerHTML = '<span class="cr-av" style="background:' + colorOf(id) + '">' + escH(draft.icon || (draft.name || '?').slice(0, 1)) + '</span>'
			+ '<div style="min-width:0"><div><span class="n">' + escH(draft.name || '（未命名）') + '</span>' + (draft.role ? '<span class="r">' + escH(draft.role) + '</span>' : '') + '<span class="cr-new">新</span></div>'
			+ '<div class="d">' + escH([draft.description, draft.model].filter(Boolean).join(' · ') || '（没写简介）') + '</div></div>';
	}
	function api(body) {
		return fetch('/x/agents/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
			.then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var err = new Error(j.error || ('HTTP ' + r.status)); err.errors = j.errors; throw err; } return j; }); });
	}
	function showValid(errors, warnings) {
		var html = '';
		for (var i = 0; i < errors.length; i++) { html += '<div class="e">✗ ' + escH(errors[i]) + '</div>'; }
		for (var j = 0; j < warnings.length; j++) { html += '<div class="w">⚠ ' + escH(warnings[j]) + '</div>'; }
		if (!errors.length) { html += '<div class="o">✓ 可以创建</div>'; }
		$('crValid').innerHTML = html;
		$('crCreate').disabled = errors.length > 0;
	}
	function validate() {
		renderCard();
		var hint = $('crModelHint');
		hint.textContent = (DATA.models || []).length
			? '下拉里是真实会话跑过的模型（' + DATA.models.length + ' 个，一定能路由）；也可以手填 provider/model'
			: (DATA.hasDefaultProvider ? '还没有会话记录可参考；手填模型名即可' : '写成 provider/model（如 vssaros-codebuddy/hy4），或留空跟随默认');
		var mine = ++seq;
		$('crCreate').disabled = true;
		return api({ action: 'validate', draft: draft }).then(function (r) {
			if (mine !== seq) { return; }
			$('crSrc').textContent = r.agentMd || '';
			$('crPath').textContent = r.file ? '将写入 ' + r.file : '';
			showValid(r.errors || [], r.warnings || []);
		}).catch(function (e) {
			if (mine !== seq) { return; }
			showValid(['校验请求失败：' + e.message], []);
		});
	}
	window.crImport = function () {
		var t = $('crImportText'); var err = $('crImportErr');
		err.hidden = true;
		api({ action: 'parse', text: t ? t.value : '' }).then(function (r) {
			var d = blank(); var src = r.draft || {};
			for (var k in d) { if (Object.prototype.hasOwnProperty.call(src, k)) { d[k] = Array.isArray(src[k]) ? src[k].join(', ') : (src[k] == null ? '' : String(src[k])); } }
			if (!d.icon) { d.icon = '🤖'; }
			toForm(d, '导入自 .agent.md');
		}).catch(function (e) { err.textContent = '✗ ' + e.message; err.hidden = false; });
	};
	window.crBack = function () { step(1); };
	window.crCancel = function () { created = null; step(1); if (typeof showTab === 'function') { showTab('overview'); } };
	window.crCreate = function () {
		var btn = $('crCreate'); btn.disabled = true; btn.textContent = '创建中…';
		api({ action: 'create', draft: draft }).then(function (r) {
			created = r;
			$('crDoneName').textContent = '已创建 ' + r.name;
			$('crDoneFile').innerHTML = '写入 <code>' + escH(r.file) + '</code>';
			$('crDoneReg').innerHTML = r.registered
				? '已注册到 dsh：<code>' + escH(r.presetId) + '</code>（不用重启 Host）'
				: '已写入；dsh 注册会在下一次刷新时完成（<code>' + escH(r.presetId) + '</code>）';
			try { if (window.localStorage) { localStorage.setItem('vssaros.agents.changed', r.id + '|' + Date.now()); } } catch (e) {}
			step(3);
		}).catch(function (e) {
			showValid(e.errors && e.errors.length ? e.errors : [e.message], []);
		}).then(function () { btn.textContent = '创建 Agent'; });
	};
	window.crOpenChat = function () {
		var bridge = window.vssarosDsh;
		if (!created) { return; }
		if (!bridge || typeof bridge.newChat !== 'function') { say('当前宿主不支持从这里开会话（需要带 newChat 的宿主）'); return; }
		try { bridge.newChat(created.presetId); say(''); } catch (e) { say('开会话失败：' + e); }
	};
	window.crSettings = function () { if (created && typeof openAgentSettings === 'function') { openAgentSettings(created.id, created.name); } };
	window.crAgain = function () { created = null; window.crBegin('blank'); };
	window.crRefresh = function () { location.reload(); };
}
/* eslint-enable */

/** 内联进 detail.js 页面脚本的那一段（与页面主脚本同一个 script 标签内）。 */
export const CREATE_CLIENT_JS = '(' + createClient.toString() + ')();';
