/**
 * 生图工作台的**壳**（shell）：三个承载面共用一份数据、三套布局。
 *
 * ⚠ 本文件是 2026-10-21 UI 重设计（插件 0.10.0）的实现稿；设计稿在
 *   `doc/dsh-imagegen-workbench-mockup.html`（**先改稿、再改这里** ⇒ 稿与实现不打架）。
 *
 * 结构：**控制台(340) │ 画廊(自适应) │ 详情(288)**；
 *   容器宽度不够（<1100）时右列详情**降级**成画廊顶部的"选中条"（不用浮层 ⇒ 不会被 overflow 裁掉）。
 *
 * 规范：`doc/workbench-authoring-standard.md` §4（一份数据获取，三个壳）§4.3（容器查询）。
 * ⚠ **禁 media query**：sideview（≈360px）与编辑区（≈1200px）在**同一个窗口**里，@media 分不开
 *   （规范 §4.3 明确点名）⇒ 一律用**容器查询**（container-type: inline-size）。
 *
 * 承载面：
 *   · `sideview` ⇒ **只做图库目录**（窄容器里塞表单必然裁切 —— 规范 §9 的反例）。
 *   · `editor` / `full` ⇒ 三栏（完整页里"画廊"就是目录那一半，不再单开一列窄目录）。
 *
 * ⚠ 下面的 CSS 是一段**模板串**：里面**不许出现反引号**，也不许出现 `${`。
 */
import { filterGallery, galleryProviders, timeRangeSince } from './gallery.js';

/** 容器名（容器查询要有个被查询的元素）。 */
const CONTAINER = 'igwb';
/** 低于这个宽度：右列详情降级成画廊顶部的"选中条"（稿子 §响应式）。 */
const DETAIL_MIN_WIDTH = 1100;

/** 页面 CSS（三个壳共用；断点一律用容器查询 ✓）。 */
export const PAGE_CSS = `
#${CONTAINER}{container-type:inline-size;container-name:${CONTAINER};height:100%;min-height:100%;}
html,body{height:100%;}
body{margin:0;overflow:hidden;background:var(--vscode-sideBar-background,#252526);color:var(--vscode-foreground,#ccc);
font:13px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;}
*{box-sizing:border-box;}
.igb{display:flex;flex-direction:column;height:100%;min-height:0;}
/* ── 顶部条 ── */
.igb-top{flex:none;display:flex;align-items:center;gap:9px;height:42px;padding:0 14px;
border-bottom:1px solid var(--vscode-panel-border,#3c3c3c);background:var(--vscode-editorWidget-background,#252526);}
.igb-title{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;white-space:nowrap;}
.igb-glyph{width:18px;height:18px;border-radius:6px;background:linear-gradient(135deg,#ff7a45,#e5544b);
display:flex;align-items:center;justify-content:center;font-size:11px;}
.igb-sp{flex:1 1 auto;min-width:0;}
.igb-badge{display:flex;align-items:center;gap:6px;max-width:100%;min-width:0;font:inherit;font-size:11px;cursor:pointer;
color:var(--vscode-descriptionForeground,#9a9a9a);border:1px solid var(--vscode-panel-border,#3c3c3c);
background:var(--vscode-input-background,#2b2b2b);border-radius:999px;padding:2px 9px;white-space:nowrap;
overflow:hidden;text-overflow:ellipsis;}
.igb-badge>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.igb-badge:hover{border-color:var(--vscode-focusBorder,#0e639c);color:var(--vscode-foreground,#ccc);}
.igb-badge .led{width:6px;height:6px;border-radius:50%;flex:none;background:var(--vscode-testing-iconPassed,#39b56a);}
.igb-badge.warn{color:var(--vscode-editorWarning-foreground,#cca700);border-color:rgba(224,166,58,.45);background:rgba(224,166,58,.1);}
.igb-badge.warn .led{background:var(--vscode-editorWarning-foreground,#cca700);}
/* ── 按钮 / 表单 ── */
.igb-btn{padding:4px 10px;border-radius:6px;border:1px solid var(--vscode-panel-border,#3c3c3c);cursor:pointer;
font:inherit;font-size:11.5px;white-space:nowrap;background:var(--vscode-button-secondaryBackground,#3a3d41);
color:var(--vscode-button-secondaryForeground,#ccc);}
.igb-btn:hover{filter:brightness(1.12);}
.igb-btn.primary{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);
border-color:transparent;font-weight:600;}
.igb-btn.ghost{background:transparent;color:var(--vscode-descriptionForeground,#9a9a9a);}
.igb-btn[disabled]{opacity:.45;cursor:default;}
.igb input,.igb textarea,.igb select{width:100%;padding:6px 8px;border-radius:6px;font:inherit;font-size:12px;
color:var(--vscode-input-foreground,#ccc);background:var(--vscode-input-background,#3c3c3c);
border:1px solid var(--vscode-input-border,#3c3c3c);}
.igb input:focus,.igb textarea:focus,.igb select:focus{outline:none;border-color:var(--vscode-focusBorder,#0e639c);}
.igb textarea{min-height:86px;resize:vertical;line-height:1.6;}
.igb-fld{display:flex;flex-direction:column;gap:4px;min-width:0;}
.igb-fld>label{font-size:10.5px;color:var(--vscode-descriptionForeground,#9a9a9a);}
.igb-grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.igb-row{display:flex;gap:7px;flex-wrap:wrap;align-items:center;}
.igb-sec{font-size:11px;letter-spacing:.06em;color:var(--vscode-descriptionForeground,#9a9a9a);
display:flex;align-items:center;gap:8px;}
.igb-ratio{font-size:11px;color:var(--vscode-descriptionForeground,#9a9a9a);background:var(--vscode-input-background,#3c3c3c);
border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:6px;padding:3px 9px;cursor:pointer;font:inherit;}
.igb-ratio:hover{border-color:var(--vscode-focusBorder,#0e639c);color:var(--vscode-foreground,#ccc);}
.igb-ratio.on{border-color:var(--vscode-focusBorder,#0e639c);color:var(--vscode-foreground,#ccc);
background:var(--vscode-list-activeSelectionBackground,#094771);}
.igb-status{display:flex;align-items:flex-start;gap:8px;font-size:11.5px;color:var(--vscode-descriptionForeground,#9a9a9a);
background:var(--vscode-input-background,#2b2b2b);border:1px solid var(--vscode-panel-border,#3c3c3c);
border-radius:8px;padding:8px 10px;}
.igb-status .led{width:7px;height:7px;border-radius:50%;flex:none;margin-top:5px;background:var(--vscode-descriptionForeground,#9a9a9a);}
.igb-status.ok .led{background:var(--vscode-testing-iconPassed,#39b56a);}
.igb-status.busy .led{background:var(--vscode-charts-blue,#4d7cfe);}
.igb-status.err .led{background:var(--vscode-editorError-foreground,#f14c4c);}
.igb-more{border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:8px;background:var(--vscode-editorWidget-background,#252526);}
.igb-more>summary{list-style:none;cursor:pointer;padding:7px 10px;font-size:11.5px;
color:var(--vscode-descriptionForeground,#9a9a9a);display:flex;align-items:center;gap:6px;}
.igb-more>summary::-webkit-details-marker{display:none;}
.igb-more>summary::before{content:"▸";font-size:10px;}
.igb-more[open]>summary::before{content:"▾";}
.igb-more .inner{padding:0 10px 10px;display:flex;flex-direction:column;gap:8px;}
.igb-ex{text-align:left;font-size:11.5px;color:var(--vscode-descriptionForeground,#9a9a9a);
background:var(--vscode-input-background,#2b2b2b);border:1px dashed var(--vscode-panel-border,#3c3c3c);
border-radius:7px;padding:6px 9px;cursor:pointer;font:inherit;}
.igb-ex:hover{color:var(--vscode-foreground,#ccc);border-color:var(--vscode-focusBorder,#0e639c);}
/* ── 三栏骨架 ── */
.igb-body{flex:1;min-height:0;display:flex;}
.igb-cons{flex:0 0 340px;min-width:0;border-right:1px solid var(--vscode-panel-border,#3c3c3c);
padding:12px;overflow:auto;display:flex;flex-direction:column;gap:11px;}
.igb-gside{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;min-height:0;}
.igb-detailcol{flex:0 0 288px;min-width:0;border-left:1px solid var(--vscode-panel-border,#3c3c3c);
padding:12px;overflow:auto;display:flex;flex-direction:column;gap:10px;}
/* ── 画廊 ── */
.igb-ghead{flex:none;display:flex;align-items:center;gap:8px;height:40px;padding:0 12px;
border-bottom:1px solid var(--vscode-panel-border,#3c3c3c);}
.igb-ghead .cnt{font-size:12px;color:var(--vscode-descriptionForeground,#9a9a9a);white-space:nowrap;}
.igb-ghead .cnt b{color:var(--vscode-foreground,#ccc);font-weight:600;}
.igb-ghead select{width:auto;font-size:11.5px;padding:4px 7px;}
.igb-gsearch{width:170px;font-size:11.5px;padding:4px 9px;}
.igb-gbody{flex:1;min-height:0;overflow:auto;padding:12px;}
.igb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;}
.igb-tile{position:relative;display:block;text-align:left;padding:0;cursor:pointer;overflow:hidden;
border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:10px;background:var(--vscode-editor-background,#1e1e1e);}
.igb-tile:hover{border-color:var(--vscode-descriptionForeground,#9a9a9a);}
.igb-tile.on{border-color:var(--vscode-focusBorder,#0e639c);box-shadow:0 0 0 1px var(--vscode-focusBorder,#0e639c);}
.igb-tile img{display:block;width:100%;height:112px;object-fit:contain;background:#15161a;}
.igb-tile .ph{height:112px;display:flex;align-items:center;justify-content:center;
color:var(--vscode-descriptionForeground,#9a9a9a);font-size:10.5px;}
.igb-tile .cap{padding:6px 8px;font-size:10.5px;color:var(--vscode-descriptionForeground,#9a9a9a);}
.igb-tile .cap .txt{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.igb-tile .src{position:absolute;top:6px;left:6px;font-size:9.5px;padding:1px 6px;border-radius:999px;
background:rgba(0,0,0,.55);color:#dfe3ea;}
.igb-tile .prov{position:absolute;top:6px;right:6px;font-size:9.5px;padding:1px 6px;border-radius:999px;
background:rgba(0,0,0,.55);color:#dfe3ea;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.igb-empty{border:1px dashed var(--vscode-panel-border,#3c3c3c);border-radius:10px;padding:26px 18px;
text-align:center;color:var(--vscode-descriptionForeground,#9a9a9a);font-size:12px;}
/* ── 详情（右列） ── */
.igb-dprev{display:flex;align-items:center;justify-content:center;height:168px;cursor:zoom-in;overflow:hidden;
border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:10px;background:var(--vscode-editor-background,#1e1e1e);}
.igb-dprev img{max-width:100%;max-height:100%;object-fit:contain;}
.igb-meta{display:flex;flex-direction:column;gap:5px;font-size:11.5px;color:var(--vscode-descriptionForeground,#9a9a9a);
word-break:break-word;}
.igb-meta .k{color:var(--vscode-descriptionForeground,#9a9a9a);}
.igb-meta code{font-family:var(--vscode-editor-font-family,monospace);font-size:10.5px;word-break:break-all;}
.igb-dact{display:flex;gap:6px;flex-wrap:wrap;}
/* ── 选中条（窄宽时详情降级成它） ── */
.igb-dbar{flex:none;display:none;align-items:center;gap:10px;padding:8px 12px;
border-bottom:1px solid var(--vscode-panel-border,#3c3c3c);background:var(--vscode-editorWidget-background,#252526);}
.igb-dbar .mini{width:52px;height:52px;flex:none;cursor:zoom-in;overflow:hidden;
border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:7px;background:var(--vscode-editor-background,#1e1e1e);
display:flex;align-items:center;justify-content:center;}
.igb-dbar .mini img{width:100%;height:100%;object-fit:contain;}
.igb-dbar .mid{flex:1 1 auto;min-width:0;}
.igb-dbar .mid .p{font-size:11.5px;color:var(--vscode-foreground,#ccc);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.igb-dbar .mid .m{font-size:10.5px;color:var(--vscode-descriptionForeground,#9a9a9a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* ── 内联大图预览（不浮层 ⇒ 不会被 overflow 裁掉） ── */
.igb-light{display:flex;flex-direction:column;align-items:center;gap:10px;}
.igb-light .big{display:flex;align-items:center;justify-content:center;width:100%;max-width:760px;min-height:240px;
max-height:62vh;overflow:hidden;border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:10px;
background:var(--vscode-editor-background,#1e1e1e);}
.igb-light .big img{max-width:100%;max-height:62vh;object-fit:contain;}
.igb-light .lnav{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;}
/* ── 侧栏目录 ── */
.igb-cat{height:100%;min-height:0;overflow:auto;padding:11px;display:flex;flex-direction:column;gap:10px;}
.igb-cathead{display:flex;align-items:center;gap:8px;}
.igb-cathead .ttl{font-size:12px;font-weight:600;}
.igb-cathead .cnt{font-size:11.5px;color:var(--vscode-descriptionForeground,#9a9a9a);}
.igb-catgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;}
.igb-catgrid .igb-tile img{height:78px;}
.igb-catgrid .igb-tile .ph{height:78px;}
/* ── 响应式：一律容器查询（禁 media query，规范 §4.3） ── */
@container ${CONTAINER} (max-width:${DETAIL_MIN_WIDTH}px){
.igb-detailcol{display:none;}
.igb-dbar{display:flex;}
.igb-cons{flex-basis:320px;}
}
@container ${CONTAINER} (max-width:900px){
.igb-cons{flex-basis:300px;}
}
@container ${CONTAINER} (max-width:760px){
.igb-body{flex-direction:column;overflow:auto;}
.igb-cons{flex:0 0 auto;border-right:none;border-bottom:1px solid var(--vscode-panel-border,#3c3c3c);}
.igb-gside{min-height:260px;}
.igb-gbody{overflow:visible;}
}
@container ${CONTAINER} (max-width:520px){
.igb-grid{grid-template-columns:repeat(auto-fill,minmax(118px,1fr));}
.igb-top{height:auto;padding:7px 10px;flex-wrap:wrap;}
.igb-grid2{grid-template-columns:1fr 1fr;}
.igb-ghead{height:auto;flex-wrap:wrap;gap:6px;padding:6px 10px;}
.igb-gsearch{flex:1 1 100%;width:auto;}
}
@container ${CONTAINER} (max-width:320px){
.igb-grid{grid-template-columns:1fr 1fr;gap:7px;}
.igb-catgrid{grid-template-columns:1fr 1fr;}
.igb-tile img{height:88px;}
.igb-gsearch{width:auto;}
.igb-ghead select{max-width:94px;font-size:11px;padding:3px 4px;}
.igb-ghead .cnt{font-size:11px;}
}
`;

/** HTML 转义（提示词是用户/模型给的 ⇒ 不能直接拼进 innerHTML ✗）。 */
export function escapeHtml(text) {
	return String(text ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * 造元素（比一长串 createElement 短，也少写错 className）。
 * @param {string} tag 形如 `div.cls#id`（可带多个 `.cls`）
 * @param {object} [attrs] 属性（`text` / `html` / `value` 特殊处理；`on*` 视为事件）
 * @param {Array<Node|string>} [kids] 子节点
 * @returns {HTMLElement}
 */
function el(tag, attrs, kids) {
	const matched = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
	const node = document.createElement(matched[1] || 'div');
	for (const token of (matched[2] || '').match(/[.#][\w-]+/g) || []) {
		if (token[0] === '.') { node.classList.add(token.slice(1)); }
		else { node.id = token.slice(1); }
	}
	for (const [key, value] of Object.entries(attrs || {})) {
		if (value === undefined || value === null) { continue; }
		if (key === 'text') { node.textContent = String(value); }
		else if (key === 'html') { node.innerHTML = String(value); }
		else if (key === 'value') { node.value = value; }
		else if (key.startsWith('on') && typeof value === 'function') { node.addEventListener(key.slice(2), value); }
		else if (key === 'checked' || key === 'disabled' || key === 'selected') { node[key] = !!value; }
		else { node.setAttribute(key, String(value)); }
	}
	for (const kid of kids || []) {
		if (kid === null || kid === undefined) { continue; }
		node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
	}
	return node;
}

/** 相对时间（详情栏/选中条用）。 */
function ago(at) {
	const stamp = Number(at) || 0;
	if (!stamp) { return '时间未知'; }
	const minutes = Math.round((Date.now() - stamp) / 60000);
	if (minutes < 1) { return '刚刚'; }
	if (minutes < 60) { return minutes + ' 分钟前'; }
	const hours = Math.round(minutes / 60);
	if (hours < 24) { return hours + ' 小时前'; }
	return Math.round(hours / 24) + ' 天前';
}

/** provider 显示名（清单里可能是"xx（说明）" ⇒ 角标上只留短名）。 */
function providerLabel(providers, id) {
	const hit = (providers || []).find(item => item && item.id === id);
	const name = hit ? String(hit.name || hit.id) : String(id || '');
	return name.split('（')[0].trim() || name;
}

/** 来源角标文案。 */
function sourceLabel(source) {
	return String(source) === 'workspace' ? '工作区' : '最近';
}

/** 画廊条目（完整页/侧栏目录共用一份数据 ⇒ 一个取数，两个壳）。 */
function allItems(data) {
	return data.gallery || data.images || [];
}

/** 筛选后的可见条目（规则只有一处：`gallery.js` 的纯函数）。 */
function visibleItems(data, filters) {
	return filterGallery(allItems(data), {
		source: filters.source || 'all',
		provider: filters.provider || '',
		since: timeRangeSince(filters.range || 'all'),
		keyword: filters.keyword || '',
	});
}

/** 当前选中条目。 */
function selectedItem(data, selectedId) {
	return allItems(data).find(item => item && item.id === selectedId) || null;
}

/** 比例快捷（点一下 = 填尺寸）。 */
const RATIOS = [
	['1:1', '1024x1024'],
	['16:9', '1280x720'],
	['9:16', '720x1280'],
	['4:3', '1152x864'],
	['3:4', '864x1152'],
];

/** 示例提示词（点一下 = 填进画面描述）。 */
const EXAMPLES = [
	'黄昏的重庆街头，霓虹灯牌，湿地面反光，35mm 电影感',
	'水墨风格的远山云海，留白，极简，一只白鹤',
	'赛博朋克机械猫工作室，蓝紫打光，背景虚化',
];

/**
 * 渲染壳。
 *
 * @param {HTMLElement} root 挂载点
 * @param {object} input
 * @param {'sideview'|'editor'|'full'} input.surface 承载面
 * @param {object} input.data 一次取数的结果（画廊 + 能力表 + 画布状态）
 * @param {string} input.selectedId 当前选中的图 id
 * @param {object} input.filters 画廊筛选（来源 / provider / 时间 / 关键字）
 * @param {object} [input.draft] 表单草稿（提示词等 ⇒ 5 秒轮询重绘不丢）
 * @param {boolean} [input.zoom] 是否处于内联大图预览
 * @param {boolean} [input.bridgeOk] 页面桥可用（不可用 ⇒ 顶部徽标变黄）
 * @param {object} input.handlers 事件回调
 */
export function renderShell(root, input) {
	const surface = String(input.surface || 'full');
	const data = input.data || {};
	const handlers = input.handlers || {};
	root.innerHTML = '';
	const wrap = el('div.igb');
	root.appendChild(wrap);
	// sideview = 只做图库目录（窄容器里塞表单必然裁切）；editor / full = 控制台 │ 画廊 │ 详情。
	if (surface === 'sideview') {
		wrap.appendChild(renderTop(data, input, handlers, true));
		wrap.appendChild(renderCatalog(data, input, handlers));
		return;
	}
	wrap.appendChild(renderTop(data, input, handlers, false));
	const body = el('div.igb-body');
	wrap.appendChild(body);
	body.appendChild(renderConsole(data, input, handlers));
	const gallerySide = el('div.igb-gside');
	body.appendChild(gallerySide);
	// 详情**两份都渲染**，由容器查询决定显示哪一份（窄宽 ⇒ 降级成"选中条"）。
	gallerySide.appendChild(renderDetailBar(data, input, handlers));
	gallerySide.appendChild(renderGalleryHead(data, input, handlers));
	gallerySide.appendChild(renderGalleryBody(data, input, handlers));
	body.appendChild(renderDetailColumn(data, input, handlers));
}

/**
 * 顶部条：标题 + **连接状态徽标**（可点 = 重新检测）+ 动作按钮。
 * ⚠ 徽标取代了原来那条黄色警告条（用户口径：状态收进徽标，别单独占一行）。
 */
function renderTop(data, input, handlers, compact) {
	const info = badgeInfo(data, input);
	const badge = el('span.igb-badge' + (info.warn ? '.warn' : ''), {
		'data-igb-action': 'recheck',
		role: 'button',
		tabindex: '0',
		title: '点此重新检测（provider / 画布 / 页面桥）',
		onclick: () => handlers.onRefresh && handlers.onRefresh(),
		onkeydown: (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				if (handlers.onRefresh) { handlers.onRefresh(); }
			}
		},
	}, [
		el('span.led'),
		el('span', { text: compact ? info.short : info.text }),
	]);
	const actions = compact
		? [el('button.igb-btn.ghost', {
			type: 'button', 'data-igb-action': 'open-workbench', text: '打开工作台',
			onclick: () => handlers.onOpenWorkbench && handlers.onOpenWorkbench(),
		})]
		: [
			el('button.igb-btn.ghost', {
				type: 'button', 'data-igb-action': 'refresh', text: '刷新',
				onclick: () => handlers.onRefresh && handlers.onRefresh(),
			}),
			el('button.igb-btn.ghost', {
				type: 'button', 'data-igb-action': 'open-canvas', text: '打开画布',
				onclick: () => handlers.onOpenCanvas && handlers.onOpenCanvas(),
			}),
		];
	return el('div.igb-top', {}, [
		el('div.igb-title', {}, [
			el('span.igb-glyph', { text: '🎨' }),
			el('span', { text: compact ? '生图' : '生图工作台' }),
		]),
		badge,
		el('div.igb-sp'),
		...actions,
	]);
}

/** 徽标状态（provider 数 / 画布 / 页面桥）。 */
function badgeInfo(data, input) {
	const providers = data.providers || [];
	const canvas = data.canvas || {};
	const bridgeOk = input.bridgeOk !== false;
	const count = providers.length;
	if (!bridgeOk) {
		return { text: '页面桥不可用 · 点此重新检测', short: '页面桥不可用', warn: true };
	}
	if (!count) {
		return { text: '没有可生图的 provider · 点此重新检测', short: '没有可生图的 provider', warn: true };
	}
	return {
		text: count + ' 个 provider 可生图 · 画布' + (canvas.connected ? '已连接' : '未打开'),
		short: count + ' provider',
		warn: false,
	};
}

/** 控制台（左栏）：画面描述 + 比例 + provider/模型 + 生成 + 更多参数 + 示例。 */
function renderConsole(data, input, handlers) {
	const providers = data.providers || [];
	const box = el('aside.igb-cons', { 'data-vssaros-pane': 'core' });
	// 表单草稿：页面每 5 秒轮询重绘 ⇒ 草稿必须在**状态**里（否则用户打的字会被抹掉）。
	const form = Object.assign({ prompt: '', provider: '', model: '', size: '1024x1024', quality: '', n: 1 }, input.draft || {});
	const push = (patch) => {
		Object.assign(form, patch);
		if (handlers.onDraft) { handlers.onDraft(Object.assign({}, form)); }
	};

	// 画面描述
	const prompt = el('textarea', {
		'data-igb-field': 'prompt',
		'aria-label': '画面描述',
		placeholder: '写一句画面描述，越具体越好\n例：黄昏的重庆街头，霓虹灯牌，湿地面反光，35mm 电影感',
	});
	prompt.value = String(form.prompt || '');
	const counter = el('span', { text: prompt.value.length + ' 字' });
	prompt.addEventListener('input', () => {
		counter.textContent = prompt.value.length + ' 字';
		push({ prompt: prompt.value });
	});
	box.appendChild(el('div.igb-sec', {}, [el('span', { text: '画面描述' }), el('span.igb-sp'), counter]));
	box.appendChild(prompt);

	// 比例快捷（点一下 = 填尺寸）
	const sizeInput = el('input', { type: 'text', 'data-igb-field': 'size', 'aria-label': '尺寸', value: String(form.size || '1024x1024') });
	const ratioRow = el('div.igb-row');
	for (const [label, size] of RATIOS) {
		const chip = el('button.igb-ratio' + (String(form.size || '') === size ? '.on' : ''), {
			type: 'button', 'data-size': size, text: label,
			onclick: () => {
				sizeInput.value = size;
				for (const other of ratioRow.querySelectorAll('.igb-ratio')) { other.classList.toggle('on', other === chip); }
				push({ size });
			},
		});
		ratioRow.appendChild(chip);
	}
	sizeInput.addEventListener('input', () => {
		for (const other of ratioRow.querySelectorAll('.igb-ratio')) { other.classList.toggle('on', other.getAttribute('data-size') === sizeInput.value); }
		push({ size: sizeInput.value });
	});
	box.appendChild(ratioRow);

	// provider / 模型
	const providerSel = el('select', { 'data-igb-field': 'provider', 'aria-label': 'provider' });
	providerSel.appendChild(new Option('（默认 provider）', ''));
	for (const provider of providers) { providerSel.appendChild(new Option(provider.name || provider.id, provider.id)); }
	providerSel.value = String(form.provider || '');
	if (providerSel.selectedIndex < 0) { providerSel.selectedIndex = 0; form.provider = ''; }
	const modelSel = el('select', { 'data-igb-field': 'model', 'aria-label': '模型' });
	const fillModels = () => {
		const provider = providers.find(item => item.id === providerSel.value);
		modelSel.innerHTML = '';
		modelSel.appendChild(new Option('（默认模型）', ''));
		for (const model of (provider && provider.models) || []) { modelSel.appendChild(new Option(model.name || model.id, model.id)); }
		modelSel.value = String(form.model || '');
		if (modelSel.selectedIndex < 0) { modelSel.selectedIndex = 0; form.model = ''; }
	};
	fillModels();
	providerSel.addEventListener('change', () => { fillModels(); push({ provider: providerSel.value, model: modelSel.value }); });
	modelSel.addEventListener('change', () => push({ model: modelSel.value }));
	box.appendChild(el('div.igb-grid2', {}, [
		el('div.igb-fld', {}, [el('label', { text: 'provider' }), providerSel]),
		el('div.igb-fld', {}, [el('label', { text: '模型' }), modelSel]),
	]));

	// 生成
	const readForm = () => ({
		prompt: prompt.value,
		provider: providerSel.value,
		model: modelSel.value,
		size: sizeInput.value,
		quality: qualityInput.value,
		n: Number(countInput.value) || 1,
	});
	const genBtn = el('button.igb-btn.primary', {
		type: 'button', 'data-igb-action': 'generate', text: '生成',
		onclick: () => handlers.onGenerate && handlers.onGenerate(readForm()),
	});
	const batchBtn = el('button.igb-btn', {
		type: 'button', 'data-igb-action': 'batch', text: '按行批量',
		onclick: () => handlers.onBatch && handlers.onBatch(Object.assign({}, readForm(), {
			prompts: prompt.value.split('\n').map(line => line.trim()).filter(Boolean),
		})),
	});
	box.appendChild(el('div.igb-row', {}, [genBtn, batchBtn]));

	// 状态（页面把结果贴回这里）
	box.appendChild(el('div.igb-status', { 'data-igb-status': '1' }, [
		el('span.led'),
		el('span', { 'data-igb-status-text': '1', text: '就绪。写一句画面描述，点「生成」。' }),
	]));

	// 更多参数（尺寸 / 质量 / 张数）
	const qualityInput = el('input', {
		type: 'text', 'data-igb-field': 'quality', 'aria-label': '质量档',
		placeholder: 'high（provider 不支持会自动去掉）', value: String(form.quality || ''),
	});
	qualityInput.addEventListener('input', () => push({ quality: qualityInput.value }));
	const countInput = el('input', {
		type: 'number', min: '1', max: '4', 'data-igb-field': 'n', 'aria-label': '张数',
		value: String(form.n || 1),
	});
	countInput.addEventListener('input', () => push({ n: Number(countInput.value) || 1 }));
	box.appendChild(el('details.igb-more', {}, [
		el('summary', { text: '更多参数' }),
		el('div.inner', {}, [
			el('div.igb-grid2', {}, [
				el('div.igb-fld', {}, [el('label', { text: '尺寸' }), sizeInput]),
				el('div.igb-fld', {}, [el('label', { text: '质量档' }), qualityInput]),
			]),
			el('div.igb-fld', {}, [el('label', { text: '张数' }), countInput]),
		]),
	]));

	// 示例提示词
	const examples = el('div', { style: 'display:flex;flex-direction:column;gap:5px' });
	for (const text of EXAMPLES) {
		examples.appendChild(el('button.igb-ex', {
			type: 'button', 'data-ex': text, title: text, text: text.length > 16 ? text.slice(0, 15) + '…' : text,
			onclick: () => {
				prompt.value = text;
				counter.textContent = text.length + ' 字';
				push({ prompt: text });
			},
		}));
	}
	box.appendChild(el('div.igb-sec', {}, [el('span', { text: '试试这些' })]));
	box.appendChild(examples);
	return box;
}

/** 画廊头部：计数 + 筛选 + 搜索。 */
function renderGalleryHead(data, input, handlers) {
	const filters = input.filters || {};
	const visible = visibleItems(data, filters);
	const head = el('div.igb-ghead', {}, [
		el('span.cnt', {}, ['出图 ', el('b', { text: String(visible.length) }), ' 张']),
		el('div.igb-sp'),
		filterSelect('source', [
			['全部来源', 'all'], ['最近出图', 'recent'], ['工作区图库', 'workspace'],
		], filters.source || 'all', value => applyFilter(input, handlers, { source: value })),
		filterSelect('provider', [['全部 provider', '']].concat(
			galleryProviders(allItems(data)).map(id => [id, id]),
		), filters.provider || '', value => applyFilter(input, handlers, { provider: value })),
		filterSelect('range', [
			['不限时间', 'all'], ['今天', 'today'], ['近 7 天', 'week'],
		], filters.range || 'all', value => applyFilter(input, handlers, { range: value })),
	]);
	const search = el('input.igb-gsearch', {
		type: 'search', 'data-igb-filter': 'keyword', 'aria-label': '搜 prompt',
		placeholder: '搜 prompt…', value: String(filters.keyword || ''),
	});
	search.addEventListener('input', () => applyFilter(input, handlers, { keyword: search.value }));
	head.appendChild(search);
	return head;
}

/** 筛选下拉。 */
function filterSelect(kind, options, value, onChange) {
	const select = el('select', { 'data-igb-filter': kind, 'aria-label': '筛选' });
	for (const [label, val] of options) { select.appendChild(new Option(label, val)); }
	select.value = String(value ?? '');
	if (select.selectedIndex < 0) { select.selectedIndex = 0; }
	select.addEventListener('change', () => onChange(select.value));
	return select;
}

/** 触发筛选（状态在页面里 ⇒ 5 秒轮询重绘也不丢）。 */
function applyFilter(input, handlers, patch) {
	if (!handlers.onFilter) { return; }
	handlers.onFilter(Object.assign({}, input.filters || {}, patch));
}

/** 画廊主体：网格 或（选中时）内联大图预览。 */
function renderGalleryBody(data, input, handlers) {
	const body = el('div.igb-gbody');
	const items = allItems(data);
	const visible = visibleItems(data, input.filters || {});
	const item = selectedItem(data, input.selectedId);
	if (input.zoom && item) {
		body.appendChild(renderLightbox(item, visible, handlers));
		return body;
	}
	const grid = el('div.igb-grid', { 'data-igb-gallery': 'core' });
	for (const entry of visible) { grid.appendChild(renderTile(entry, entry.id === input.selectedId, data, handlers)); }
	body.appendChild(grid);
	if (!visible.length) {
		body.appendChild(el('div.igb-empty', {
			'data-igb-empty': '1',
			text: items.length
				? '当前筛选下没有图（换个来源 / 时间 / 关键字试试）。'
				: '还没有出图 —— 左边写一句画面描述，点「生成」。',
		}));
	}
	return body;
}

/** 一张缩略图（画廊 / 目录共用同一个构造器 ⇒ 两处长得一样 ✓）。 */
function renderTile(item, selected, data, handlers) {
	const title = item.prompt || item.name || item.id;
	const tile = el('button.igb-tile' + (selected ? '.on' : ''), {
		type: 'button', 'data-igb-image': item.id, title,
	});
	const img = el('img', { src: item.url, alt: title, loading: 'lazy' });
	img.addEventListener('error', () => { img.replaceWith(el('div.ph', { text: '图加载失败' })); });
	tile.appendChild(img);
	tile.appendChild(el('span.src', { text: sourceLabel(item.source) }));
	if (item.provider) { tile.appendChild(el('span.prov', { text: providerLabel(data.providers, item.provider) })); }
	tile.appendChild(el('div.cap', {}, [el('span.txt', { text: title, title })]));
	tile.addEventListener('click', () => { if (handlers.onSelect) { handlers.onSelect(item.id); } });
	return tile;
}

/** 内联大图预览（不浮层 ⇒ 不会被 overflow 裁掉）。 */
function renderLightbox(item, visible, handlers) {
	const wrap = el('div.igb-light', { 'data-igb-lightbox': '1' });
	const big = el('div.big', {}, [el('img', { src: item.url, alt: item.prompt || item.id })]);
	big.querySelector('img').addEventListener('error', (event) => {
		event.target.replaceWith(el('div.ph', { text: '图加载失败' }));
	});
	wrap.appendChild(big);
	const step = (delta) => {
		if (!visible.length) { return; }
		const index = visible.findIndex(entry => entry.id === item.id);
		const next = visible[(((index + delta) % visible.length) + visible.length) % visible.length];
		if (next && handlers.onSelect) { handlers.onSelect(next.id); }
	};
	wrap.appendChild(el('div.lnav', {}, [
		el('button.igb-btn', {
			type: 'button', 'data-igb-action': 'prev', text: '← 上一张',
			onclick: () => step(-1),
		}),
		el('button.igb-btn', {
			type: 'button', 'data-igb-action': 'next', text: '下一张 →',
			onclick: () => step(1),
		}),
		el('button.igb-btn.ghost', {
			type: 'button', 'data-igb-action': 'close-zoom', text: '关闭预览',
			onclick: () => { if (handlers.onZoom) { handlers.onZoom(false); } },
		}),
	]));
	return wrap;
}

/** 详情（右栏，宽容器才显示）。 */
function renderDetailColumn(data, input, handlers) {
	const column = el('div.igb-detailcol', { 'data-vssaros-pane': 'detail' });
	const item = selectedItem(data, input.selectedId);
	if (!item) {
		column.appendChild(el('div.igb-empty', { text: '选中一张图看详情。' }));
		return column;
	}
	const preview = el('div.igb-dprev', {
		'data-igb-action': 'zoom', title: '放大看',
		onclick: () => { if (handlers.onZoom) { handlers.onZoom(true); } },
	});
	const img = el('img', { src: item.url, alt: item.prompt || item.id });
	img.addEventListener('error', () => { img.replaceWith(el('div.ph', { text: '图加载失败' })); });
	preview.appendChild(img);
	column.appendChild(preview);
	column.appendChild(metaBlock(item, data));
	column.appendChild(detailActions(item, handlers));
	return column;
}

/** 详情元信息。 */
function metaBlock(item, data) {
	const size = (item.width && item.height) ? (item.width + '×' + item.height) : '—';
	const generator = item.provider
		? (providerLabel(data.providers, item.provider) + ' / ' + (item.model || '默认模型'))
		: '（未知生成器）';
	return el('div.igb-meta', {}, [
		el('div', {}, [el('span.k', { text: '提示词' }), el('br'), document.createTextNode(item.prompt || item.name || '（无）')]),
		el('div', {}, [el('span.k', { text: '生成器' }), document.createTextNode(' ' + generator)]),
		el('div', {}, [el('span.k', { text: '尺寸' }), document.createTextNode(' ' + size)]),
		el('div', {}, [el('span.k', { text: '时间' }), document.createTextNode(' ' + ago(item.at))]),
		el('div', {}, [el('span.k', { text: '图 id' }), document.createTextNode(' '), el('code', { text: item.id })]),
		el('div', {}, [
			el('span.k', { text: '落盘' }),
			document.createTextNode(' '),
			item.savedPath ? el('code', { text: item.savedPath }) : document.createTextNode('（还没存）'),
		]),
	]);
}

/** 详情动作（存盘 / 到画布 / 复制提示词）。 */
function detailActions(item, handlers) {
	return el('div.igb-dact', {}, [
		el('button.igb-btn.primary', {
			type: 'button', 'data-igb-action': 'save', text: '存到工作区',
			onclick: () => { if (handlers.onSave) { handlers.onSave(item.id); } },
		}),
		el('button.igb-btn', {
			type: 'button', 'data-igb-action': 'to-canvas', text: '到画布里改',
			onclick: () => { if (handlers.onOpenCanvas) { handlers.onOpenCanvas(item.id); } },
		}),
		el('button.igb-btn.ghost', {
			type: 'button', 'data-igb-action': 'copy', text: '复制提示词',
			onclick: () => { if (handlers.onCopyPrompt) { handlers.onCopyPrompt(item.prompt || ''); } },
		}),
	]);
}

/** 选中条（窄容器时顶替右列详情）。 */
function renderDetailBar(data, input, handlers) {
	const bar = el('div.igb-dbar', { 'data-igb-dbar': '1' });
	const item = selectedItem(data, input.selectedId);
	if (!item) { return bar; }
	const mini = el('div.mini', {
		'data-igb-action': 'zoom', title: '放大看',
		onclick: () => { if (handlers.onZoom) { handlers.onZoom(true); } },
	});
	const img = el('img', { src: item.url, alt: '' });
	img.addEventListener('error', () => { img.replaceWith(el('div.ph', { text: '失败' })); });
	mini.appendChild(img);
	bar.appendChild(mini);
	const generator = item.provider
		? (providerLabel(data.providers, item.provider) + ' / ' + (item.model || ''))
		: '未知生成器';
	bar.appendChild(el('div.mid', {}, [
		el('div.p', { text: item.prompt || item.name || item.id, title: item.prompt || item.name || item.id }),
		el('div.m', { text: generator + ' · ' + ago(item.at) + (item.savedPath ? ' · 已落盘' : ' · 还没落盘') }),
	]));
	bar.appendChild(el('div.igb-dact', {}, [
		el('button.igb-btn.primary', {
			type: 'button', 'data-igb-action': 'save', text: '存到工作区',
			onclick: () => { if (handlers.onSave) { handlers.onSave(item.id); } },
		}),
		el('button.igb-btn', {
			type: 'button', 'data-igb-action': 'to-canvas', text: '到画布里改',
			onclick: () => { if (handlers.onOpenCanvas) { handlers.onOpenCanvas(item.id); } },
		}),
	]));
	return bar;
}

/** 侧栏目录（sideview 承载面）：只有目录 + 搜索 + 两个入口，**不给生成表单**。 */
function renderCatalog(data, input, handlers) {
	const box = el('aside.igb-cat', { 'data-vssaros-pane': 'catalog' });
	const items = allItems(data);
	const keyword = String((input.filters || {}).keyword || '').trim();
	const visible = keyword
		? items.filter(item => ((item.prompt || '') + ' ' + (item.name || '') + ' ' + item.id)
			.toLowerCase().includes(keyword.toLowerCase()))
		: items;
	box.appendChild(el('div.igb-cathead', {}, [
		el('span.ttl', { text: '图库目录' }),
		el('div.igb-sp'),
		el('span.cnt', { text: visible.length + ' 张' }),
	]));
	const search = el('input.igb-gsearch', {
		type: 'search', 'data-igb-search': '1', 'aria-label': '搜 prompt',
		placeholder: '搜 prompt…', value: keyword,
	});
	search.style.width = '100%';
	search.addEventListener('input', () => applyFilter(input, handlers, { keyword: search.value }));
	box.appendChild(search);
	const grid = el('div.igb-catgrid', { 'data-igb-gallery': 'catalog' });
	for (const item of visible) { grid.appendChild(renderTile(item, item.id === input.selectedId, data, handlers)); }
	box.appendChild(grid);
	if (!visible.length) {
		box.appendChild(el('div.igb-empty', {
			'data-igb-empty': '1',
			text: '还没有出图。在工作台里生成，或在聊天里说「画一张…」—— 出的图会自动出现在这里。',
		}));
	}
	box.appendChild(el('div.igb-row', {}, [
		el('button.igb-btn', {
			type: 'button', 'data-igb-action': 'open-workbench', text: '打开生图工作台',
			onclick: () => { if (handlers.onOpenWorkbench) { handlers.onOpenWorkbench(); } },
		}),
		el('button.igb-btn.ghost', {
			type: 'button', 'data-igb-action': 'open-canvas', text: '打开画布',
			onclick: () => { if (handlers.onOpenCanvas) { handlers.onOpenCanvas(); } },
		}),
	]));
	return box;
}
