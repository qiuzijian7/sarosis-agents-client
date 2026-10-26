// @vssaros/dsh-media — 媒体库页面（2026-10-26 改版：方案 A「Eagle 原味三栏」）。
//
// 形态（结构照 Eagle 官方说明：左侧导航 / 顶部筛选 / 中间文件列表 / 右侧检查器 / 底部状态栏）：
//   ┌──────────┬────────────────────────────────┬──────────────┐
//   │ 左导航    │ 顶部：面包屑 · 搜索 · 视图 · 密度 │ 检查器        │
//   │ 快捷/分组 │ 筛选 chips                      │ 预览/元信息   │
//   │ 标签      │ 主区：网格 / 瀑布流 / 列表        │ 标签/分组/注释 │
//   ├──────────┴────────────────────────────────┴──────────────┤
//   │ 状态栏（数量 · 已选 · 数据源）                              │
//   └──────────────────────────────────────────────────────────┘
//
// 本文件只负责**服务端首屏**（SSR）：统计/左栏聚合/首屏卡片/检查器初值。
// 交互全在 `lib/mediaApp.js`（作为 `/x/media/app.js` 单独下发）—— 好处是那份脚本是**真正的 .js 文件**，
// 不用挤进模板字符串，也就不存在"注释里一个反引号把整页脚本截断"的老坑（见 README 5.119）。
//
// ⚠ 锚点契约（探针 p3-37 钉的就是这些，改页面别改名）：
//   `data-vssaros-page="media"`（外壳给）、`data-vssaros-media-root/dir/via/tools/sync`
//   `data-vssaros-media-assets/deleted/bytes/kind/count`、`data-vssaros-media-open`、`data-vssaros-media-list`。
import { escapeHtml, renderShell } from './pageShell.js';

/** 类型 → 中文名（与左栏/卡片角标一致；index.js 的面包屑也用它）。 */
export const KIND_LABEL = { image: '图片', video: '视频', audio: '音频', text: '文本' };
/** 类型 → 占位字形（没有缩略图时画这个，不用 emoji 以免不同字体下宽度跳）。 */
const KIND_GLYPH = { image: '▣', video: '▶', audio: '♪', text: '¶' };

/** 字节数 → 人读（与工具输出同一口径）。 */
export function formatBytes(value) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) { return '0 B'; }
	const units = ['B', 'KB', 'MB', 'GB'];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
	return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 毫秒 → `2026-10-26 21:04`（本地时区，跟用户在资源管理器里看到的一致）。 */
export function formatTime(ms) {
	const n = Number(ms);
	if (!Number.isFinite(n) || n <= 0) { return '未知'; }
	const d = new Date(n);
	const pad = v => String(v).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 尺寸文案（宽高缺失时给破折号，不编 0×0）。 */
export function dimText(asset) {
	return asset?.width && asset?.height ? `${asset.width}×${asset.height}` : '—';
}

/**
 * 卡片/检查器上显示的**名字**。
 *
 * ★ 2026-10-26（真机数据暴露的问题）：真库 667 条里 **111 条没有 `file_name`**
 *   （IDE 侧迁移来的 ComfyUI 产出只落了 file_path，没落名字）⇒ 直接兜到 id 会显示一整串 UUID，
 *   而崩溃点正是"网格最上面那几行"（created_at 倒序）⇒ 第一眼就是乱码感。
 *   兜底顺序：文件名 → file_path 的 basename → ref 里的文件名（`?filename=` 或末段）→ prompt 首句 → id 前 8 位。
 */
export function displayNameOf(asset) {
	const name = String(asset?.fileName ?? asset?.name ?? '').trim();
	if (name) { return name; }
	const fromPath = (value) => {
		const text = String(value ?? '').trim();
		if (!text) { return ''; }
		const base = text.split(/[\\/]/).filter(Boolean).pop() ?? '';
		return base.replace(/\?.*$/, '');
	};
	const refText = String(asset?.ref ?? '');
	const refName = /[?&]filename=([^&]+)/.exec(refText)?.[1] ?? '';
	if (refName) {
		try { return decodeURIComponent(refName); } catch { return refName; }
	}
	const fromFile = fromPath(asset?.filePath) || fromPath(refText);
	if (fromFile) { return fromFile; }
	const prompt = String(asset?.prompt ?? '').trim();
	if (prompt) { return prompt.length > 24 ? prompt.slice(0, 24) + '…' : prompt; }
	return String(asset?.id ?? '').slice(0, 8);
}

/**
 * 统一视图模型（**服务端与客户端共用同一份字段**；客户端那份在 mediaApp.js 里逐字对应）。
 * @param {object} asset dsh 库资产（`ownStore.list` 的形状）或 IDE 镜像资产（`store.listAssets`）
 * @param {object} opts `{source: 'dsh'|'ide', apiPrefix: string}`
 */
export function toView(asset, { source, apiPrefix }) {
	const id = String(asset.id ?? '');
	const kind = String(asset.kind ?? 'image');
	const hasBytes = source === 'dsh' ? !!asset.filePath : false;
	const hasThumb = source === 'dsh' && asset.hasThumb === true;
	// ★ 2026-10-26（真机事故）：**别把非图片的原始字节塞进 `<img>`**。
	//   原来这里对任何"有字节"的资产都给 `bytes/<id>` ⇒ 79 条视频变成 79 个 `<img src=xxx.mp4>`：
	//   ① 视频当然不显示（破图）；② 每个都把整段视频拉一遍，Host 又是同步读 ⇒ 整个 dsh 卡死。
	//   现在：有缩略图（含视频**海报**）就走 thumb；纯图片才回退原图；音频/文本一律占位字形。
	const imgUrl = hasThumb
		? `${apiPrefix}thumb/${encodeURIComponent(id)}`
		: (kind === 'image' && hasBytes ? `${apiPrefix}bytes/${encodeURIComponent(id)}` : '');
	return {
		id,
		kind,
		kindLabel: KIND_LABEL[kind] ?? kind,
		name: displayNameOf(asset),
		sizeBytes: Number(asset.bytes ?? asset.sizeBytes ?? 0) || 0,
		createdAt: Number(asset.createdAt ?? 0) || 0,
		favorite: asset.favorite === true,
		board: asset.board ? String(asset.board) : '',
		tags: Array.isArray(asset.tags) ? asset.tags.map(String) : [],
		note: asset.note ? String(asset.note) : '',
		width: Number(asset.width ?? 0) || 0,
		height: Number(asset.height ?? 0) || 0,
		provider: asset.provider ? String(asset.provider) : '',
		mime: asset.mime ? String(asset.mime) : '',
		ext: asset.ext ? String(asset.ext) : '',
		prompt: asset.prompt ? String(asset.prompt) : '',
		sha8: asset.sha8 ? String(asset.sha8) : '',
		imgUrl,
		hasThumb,
		hasBytes,
		// 「AI 助手」把选中素材投成聊天引用时要真实磁盘路径（仅引用资产没有）
		filePath: asset.filePath ? String(asset.filePath) : '',
		deleted: asset.isDeleted === true || asset.deleted === true,
	};
}

/** 一张卡片（SSR；客户端 mediaApp.js 里同名函数逐字对应）。 */
function cardHtml(view) {
	const img = view.imgUrl
		? `<img src="${escapeHtml(view.imgUrl)}" alt="" loading="lazy" decoding="async" data-vssaros-media-img>`
		: `<span class="m-glyph">${KIND_GLYPH[view.kind] ?? '▣'}</span>`;
	const meta = [dimText(view), view.sizeBytes ? formatBytes(view.sizeBytes) : ''].filter(Boolean).join(' · ');
	return `<button type="button" class="m-card" data-id="${escapeHtml(view.id)}" data-kind="${escapeHtml(view.kind)}"`
		+ ` title="${escapeHtml(view.name)}">`
		+ `<span class="m-thumb" data-ar="${view.width && view.height ? `${view.width}/${view.height}` : ''}">${img}`
		+ `<span class="m-kbadge">${escapeHtml(view.kindLabel)}</span>`
		+ (view.favorite ? '<span class="m-fav" title="已收藏">★</span>' : '')
		+ '<span class="m-check">✓</span>'
		+ '</span>'
		+ `<span class="m-name">${escapeHtml(view.name)}</span>`
		+ `<span class="m-meta">${escapeHtml(meta)}</span>`
		+ '</button>';
}

/** 左栏一个导航项。 */
function navHtml({ key, label, count, icon, active }) {
	return `<button type="button" class="m-nav${active ? ' on' : ''}" data-nav="${escapeHtml(key)}" title="${escapeHtml(label)}">`
		+ `<span class="ic">${icon}</span><span class="lb">${escapeHtml(label)}</span>`
		+ `<span class="n">${escapeHtml(String(count ?? 0))}</span></button>`;
}

/** 检查器（SSR 初值 + 客户端按同一结构重绘）。 */
function inspectorHtml(view, { writable, boards }) {
	if (!view) {
		return '<div class="m-empty">未选中资产</div>';
	}
	const pv = view.imgUrl
		? `<img src="${escapeHtml(view.imgUrl)}" alt="" data-vssaros-media-insp-img>`
		: `<span class="m-glyph big">${KIND_GLYPH[view.kind] ?? '▣'}</span>`;
	const tagChips = view.tags.map(t => `<span class="m-tg" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}`
		+ (writable ? '<i class="m-tgx" data-tag-del="' + escapeHtml(t) + '" title="移除标签">×</i>' : '')
		+ '</span>').join('');
	const boardOptions = ['<option value="">（未分组）</option>'].concat(
		boards.map(b => `<option value="${escapeHtml(b)}"${b === view.board ? ' selected' : ''}>${escapeHtml(b)}</option>`),
	).join('');
	const ro = writable ? '' : ' disabled';
	return `<div class="m-pv">${pv}</div>`
		+ `<h4 class="m-iname" data-vssaros-media-insp-name>${escapeHtml(view.name)}</h4>`
		+ `<div class="m-isub">${escapeHtml(view.kindLabel)}${view.mime ? ' · ' + escapeHtml(view.mime) : ''}`
		+ `${view.sizeBytes ? ' · ' + formatBytes(view.sizeBytes) : ''}${view.favorite ? ' · ★ 已收藏' : ''}</div>`
		+ `<div class="m-blk"><div class="m-bh">元信息</div><dl class="m-kv">`
		+ `<dt>尺寸</dt><dd>${escapeHtml(dimText(view))}</dd>`
		+ `<dt>格式</dt><dd>${escapeHtml((view.ext || '—').toUpperCase())}</dd>`
		+ `<dt>大小</dt><dd>${escapeHtml(formatBytes(view.sizeBytes))}</dd>`
		+ `<dt>来源</dt><dd>${escapeHtml(view.provider || '—')}</dd>`
		+ `<dt>导入</dt><dd>${escapeHtml(formatTime(view.createdAt))}</dd>`
		+ `</dl></div>`
		+ `<div class="m-blk"><div class="m-bh">分组</div>`
		+ `<select class="m-input" name="board" data-insp-board${ro}>${boardOptions}</select></div>`
		+ `<div class="m-blk"><div class="m-bh">标签</div><div class="m-tags">${tagChips || '<span class="m-dim">（无标签）</span>'}</div>`
		+ (writable ? '<div class="m-tagadd"><input class="m-input" name="tag" data-insp-taginput placeholder="加标签后回车" maxlength="24"><button type="button" class="m-btn sm" data-insp-tagadd>+ 添加</button></div>' : '')
		+ '</div>'
		+ `<div class="m-blk"><div class="m-bh">注释</div>`
		+ (writable
			? `<textarea class="m-input m-note" name="note" data-insp-note rows="3" placeholder="这张素材的备注（自动保存）">${escapeHtml(view.note)}</textarea>`
			: `<div class="m-dim">${escapeHtml(view.note || '（无）')}</div>`)
		+ '</div>'
		+ (view.prompt ? `<div class="m-blk"><div class="m-bh">Prompt</div><div class="m-prompt">${escapeHtml(view.prompt)}</div></div>` : '')
		+ `<div class="m-acts">`
		+ `<button type="button" class="m-btn primary" data-act="fav">${view.favorite ? '★ 取消收藏' : '☆ 收藏'}</button>`
		+ (writable
			? (view.deleted
				? '<button type="button" class="m-btn" data-act="restore">↺ 恢复</button>'
				+ '<button type="button" class="m-btn danger" data-act="purge" title="物理删除这一行和它的文件（不可恢复）">⨯ 永久删除</button>'
				: '<button type="button" class="m-btn danger" data-act="delete">⌫ 移入回收站</button>')
			: '')
		+ '</div>';
}

/** 页面样式（只用 --vscode-* 变量 + 兜底，不引新色板）。 */
export const MEDIA_CSS = `
.m-app { display: flex; flex: 1; min-height: 0; background: var(--vscode-editor-background, #1e1e1e); }
.m-side { flex: 0 0 208px; width: 208px; overflow-y: auto; padding-bottom: 10px;
	border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,.28));
	background: var(--vscode-sideBar-background, #252526); }
.m-side.hide { display: none; }
.m-sec { padding: 8px 10px 3px; font-size: 9.5px; letter-spacing: .07em; text-transform: uppercase;
	color: var(--vscode-descriptionForeground, #999); }
.m-nav { display: flex; align-items: center; gap: 7px; width: 100%; background: none; border: 0;
	color: var(--vscode-foreground, #ccc); font: inherit; font-size: 12px; text-align: left;
	padding: 4px 10px 4px 12px; cursor: pointer; }
.m-nav:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
.m-nav.on { background: var(--vscode-list-activeSelectionBackground, #094771);
	color: var(--vscode-list-activeSelectionForeground, #fff); }
.m-nav .ic { flex: 0 0 13px; width: 13px; text-align: center; opacity: .85; }
.m-nav .lb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m-nav .n { font-size: 10px; opacity: .72; font-variant-numeric: tabular-nums; }
.m-nav.drop { outline: 1px dashed var(--vscode-focusBorder, #4d9fff); outline-offset: -2px; }
.m-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.m-top { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 6px 10px;
	border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.28)); }
.m-crumb { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.m-crumb .sep { color: var(--vscode-descriptionForeground, #999); font-weight: 400; margin: 0 5px; }
.m-crumb .cnt { color: var(--vscode-descriptionForeground, #999); font-weight: 400; font-size: 10.5px; margin-left: 6px; }
.m-grow { flex: 1; min-width: 0; }
.m-search { display: flex; align-items: center; gap: 5px; flex: 0 1 220px; min-width: 90px;
	background: var(--vscode-input-background, rgba(128,128,128,.12));
	border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); border-radius: 4px; padding: 2px 7px; }
.m-search span { font-size: 11px; opacity: .6; }
.m-search input { flex: 1; min-width: 0; background: none; border: 0; outline: none; color: inherit;
	font: inherit; font-size: 11.5px; padding: 1px 0; }
.m-seg { display: inline-flex; flex: 0 0 auto; border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
	border-radius: 4px; overflow: hidden; }
.m-seg button { background: none; border: 0; color: var(--vscode-descriptionForeground, #999);
	font: inherit; font-size: 11.5px; padding: 3px 8px; cursor: pointer; line-height: 1.35; }
.m-seg button + button { border-left: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); }
.m-seg button.on { background: var(--vscode-list-activeSelectionBackground, #094771);
	color: var(--vscode-list-activeSelectionForeground, #fff); }
.m-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px;
	padding: 3px 9px; border-radius: 4px; font: inherit; font-size: 11.5px; cursor: pointer;
	background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.16));
	color: var(--vscode-button-secondaryForeground, inherit);
	border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
.m-btn:hover { filter: brightness(1.1); }
.m-btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
	border-color: transparent; }
.m-btn.danger { color: var(--vscode-errorForeground, #f14c4c); }
/* 破坏性操作的"第二步"：按钮自己变成确认态（不用原生 confirm，WebContentsView 里可能被拦） */
.m-btn.armed { background: var(--vscode-inputValidation-errorBackground, rgba(241,76,76,.28));
	color: #fff; border-color: var(--vscode-errorForeground, #f14c4c); }
.m-btn.sm { padding: 2px 7px; font-size: 10.5px; }
.m-btn[disabled] { opacity: .45; cursor: default; }
.m-density { -webkit-appearance: none; appearance: none; flex: 0 0 auto; width: 66px; height: 3px;
	background: var(--vscode-input-border, rgba(128,128,128,.35)); border-radius: 3px; outline: none; }
.m-density::-webkit-slider-thumb { -webkit-appearance: none; width: 10px; height: 10px; border-radius: 50%;
	background: var(--vscode-focusBorder, #4d9fff); cursor: pointer; }
.m-chips { flex: 0 0 auto; display: flex; align-items: center; gap: 5px; padding: 5px 10px;
	border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.28)); overflow-x: auto; }
.m-chips .glabel { flex: 0 0 auto; font-size: 10px; color: var(--vscode-descriptionForeground, #999); margin-right: 1px; }
.m-chip { flex: 0 0 auto; font-size: 10.5px; padding: 1px 8px; border-radius: 9px; cursor: pointer;
	border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); background: none;
	color: var(--vscode-descriptionForeground, #999); font-family: inherit; white-space: nowrap; }
.m-chip:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); color: inherit; }
.m-chip.on { background: var(--vscode-list-activeSelectionBackground, #094771);
	color: var(--vscode-list-activeSelectionForeground, #fff); border-color: transparent; }
.m-vsep { flex: 0 0 auto; width: 1px; height: 13px; margin: 0 2px;
	background: var(--vscode-input-border, rgba(128,128,128,.35)); }
.m-banner { flex: 0 0 auto; margin: 6px 10px 0; padding: 4px 9px; border-radius: 4px; font-size: 11px;
	border: 1px solid var(--vscode-inputValidation-infoBorder, #3b6ea5);
	background: var(--vscode-inputValidation-infoBackground, rgba(59,110,165,.16)); }
.m-list { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; }
.m-cards { display: grid; }
.m-list.mode-grid .m-cards { display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(var(--thumb, 168px), 100%), 1fr)); gap: 11px; align-content: start; }
.m-list.mode-masonry .m-cards { display: block; column-width: var(--thumb, 168px); column-gap: 11px; }
.m-list.mode-masonry .m-card { display: inline-block; width: 100%; margin: 0 0 11px; break-inside: avoid; }
.m-list.mode-list .m-cards { display: flex; flex-direction: column; gap: 2px; }
.m-list.mode-list .m-card { display: grid; grid-template-columns: 46px minmax(0, 1fr);
	grid-template-rows: auto auto; column-gap: 9px; padding: 4px 7px; border-radius: 5px; }
.m-list.mode-list .m-thumb { grid-area: 1 / 1 / 3 / 2; width: 46px; height: 46px; aspect-ratio: auto !important; }
.m-list.mode-list .m-name { grid-area: 1 / 2; margin-top: 0; }
.m-list.mode-list .m-meta { grid-area: 2 / 2; }
.m-card { position: relative; background: none; border: 0; padding: 0; font: inherit; color: inherit;
	text-align: left; cursor: pointer; border-radius: 7px; }
.m-card:focus-visible { outline: 1px solid var(--vscode-focusBorder, #4d9fff); outline-offset: 2px; }
.m-thumb { position: relative; display: block; width: 100%; aspect-ratio: 1;
	border-radius: 7px; overflow: hidden; background: var(--vscode-editorWidget-background, rgba(128,128,128,.14));
	border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.28)); }
.m-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; background: #101014; }
.m-glyph { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
	font-size: 24px; color: var(--vscode-descriptionForeground, #999); opacity: .8; }
.m-kbadge { position: absolute; left: 5px; bottom: 5px; font-size: 9px; padding: 0 5px; border-radius: 7px;
	background: rgba(0,0,0,.6); color: #fff; }
.m-fav { position: absolute; right: 5px; top: 4px; font-size: 11px; color: #f0b429;
	text-shadow: 0 1px 3px rgba(0,0,0,.75); }
.m-check { position: absolute; left: 5px; top: 5px; display: none; width: 14px; height: 14px;
	border-radius: 3px; background: var(--vscode-focusBorder, #4d9fff); color: #08111c;
	font-size: 9px; line-height: 14px; text-align: center; }
.m-card.sel .m-thumb { outline: 2px solid var(--vscode-focusBorder, #4d9fff); outline-offset: -2px; }
.m-card.sel .m-check { display: block; }
.m-card:hover .m-thumb { border-color: var(--vscode-focusBorder, #4d9fff); }
.m-name { display: block; margin-top: 4px; font-size: 11.5px; overflow: hidden;
	text-overflow: ellipsis; white-space: nowrap; }
.m-meta { display: block; font-size: 10px; color: var(--vscode-descriptionForeground, #999);
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m-insp { flex: 0 0 284px; width: 284px; overflow-y: auto; padding: 10px;
	border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,.28));
	background: var(--vscode-sideBar-background, #252526); }
.m-insp.hide { display: none; }
.m-pv { position: relative; width: 100%; aspect-ratio: 4 / 3; border-radius: 7px; margin-bottom: 8px;
	overflow: hidden; background: var(--vscode-editorWidget-background, rgba(128,128,128,.14));
	border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.28)); }
.m-pv img { display: block; width: 100%; height: 100%; object-fit: contain; background: #101014; }
.m-glyph.big { font-size: 34px; }
.m-iname { margin: 0 0 2px; font-size: 12.5px; font-weight: 600; overflow: hidden;
	text-overflow: ellipsis; white-space: nowrap; }
.m-isub { font-size: 10.5px; color: var(--vscode-descriptionForeground, #999); margin-bottom: 8px;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m-blk { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22)); padding: 7px 0; }
.m-bh { font-size: 9.5px; letter-spacing: .07em; text-transform: uppercase; margin-bottom: 4px;
	color: var(--vscode-descriptionForeground, #999); }
.m-kv { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 1px 8px; margin: 0; font-size: 11px; }
.m-kv dt { color: var(--vscode-descriptionForeground, #999); }
.m-kv dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m-input { width: 100%; font: inherit; font-size: 11px; padding: 3px 6px; border-radius: 4px;
	border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
	background: var(--vscode-input-background, rgba(128,128,128,.1)); color: inherit; outline: none; }
.m-input:focus { border-color: var(--vscode-focusBorder, #4d9fff); }
.m-note { resize: vertical; min-height: 48px; font-family: inherit; }
.m-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.m-tg { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; padding: 0 6px; border-radius: 8px;
	background: var(--vscode-badge-background, rgba(128,128,128,.22));
	color: var(--vscode-badge-foreground, inherit); }
.m-tgx { cursor: pointer; font-style: normal; opacity: .6; }
.m-tgx:hover { opacity: 1; color: var(--vscode-errorForeground, #f14c4c); }
.m-tagadd { display: flex; gap: 4px; margin-top: 5px; }
.m-prompt { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; line-height: 1.5;
	background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12)); border-radius: 4px;
	padding: 5px 6px; max-height: 76px; overflow: auto; word-break: break-word; }
.m-acts { display: flex; gap: 5px; margin-top: 8px; }
.m-dim { color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
.m-status { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 4px 10px; font-size: 10px;
	color: var(--vscode-descriptionForeground, #999);
	border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.28));
	background: var(--vscode-editorWidget-background, rgba(128,128,128,.06)); }
.m-status b { color: var(--vscode-foreground, #ccc); font-weight: 600; font-variant-numeric: tabular-nums; }
.m-empty { padding: 30px 0; text-align: center; color: var(--vscode-descriptionForeground, #999); font-size: 12px; }
.m-batch { position: absolute; left: 50%; bottom: 34px; transform: translate(-50%, 10px); z-index: 40;
	display: none; align-items: center; gap: 6px; padding: 5px 9px; border-radius: 8px;
	background: var(--vscode-editorWidget-background, #2a2a2e);
	border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.45));
	box-shadow: 0 10px 26px rgba(0,0,0,.45); font-size: 11px; }
.m-batch.on { display: flex; transform: translate(-50%, 0); }
/* 拖文件进来的落点提示（整块列表） */
.m-list.drop-target { outline: 2px dashed var(--vscode-focusBorder, #4d9fff); outline-offset: -7px;
	background: rgba(77,159,255,.07); }
/* 导入进度（复用批量条的位置逻辑，但独立元素：批量条可能同时开着） */
.m-up { display: none; position: absolute; right: 14px; bottom: 34px; z-index: 41; max-width: 60%;
	padding: 4px 10px; border-radius: 5px; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	background: var(--vscode-editorWidget-background, #2a2a2e);
	border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.45));
	box-shadow: 0 8px 22px rgba(0,0,0,.4); }
.m-up.on { display: block; }
.m-diag { display: none; }
.m-side-toggle { display: none; }
@media (max-width: 1080px) {
	.m-side { flex-basis: 168px; width: 168px; }
	.m-insp { flex-basis: 240px; width: 240px; }
}
/* 窄容器（IDE 中栏 ~700 / 侧栏 ~340）：导航与检查器都改成浮层，列表独占整宽。
   ⚠ 不这样做的话三栏在 300 多像素下会挤成"卡片被压到几十像素、文字逐字换行"（本仓踩过）。 */
@media (max-width: 820px) {
	.m-side-toggle { display: inline-flex; }
	.m-side { position: absolute; left: 0; top: 0; bottom: 0; z-index: 31; display: none;
		width: 208px; flex-basis: 208px; box-shadow: 8px 0 24px rgba(0,0,0,.45); }
	.m-side.show { display: block; }
	.m-insp { position: absolute; right: 0; top: 0; bottom: 0; z-index: 30;
		width: min(280px, 88%); flex-basis: 280px; box-shadow: -10px 0 26px rgba(0,0,0,.45); }
}
`;

/**
 * 渲染整页（SSR）。
 * @param {object} opts
 * @param {object[]} opts.views 首屏资产（`toView` 的结果）
 * @param {object} opts.facets 左栏聚合（`ownStore.facets`；IDE 镜像下为 undefined）
 * @param {object} opts.stats `{assetCount,totalBytes,deletedCount,byKind}`
 * @param {object} opts.filter 当前筛选（左栏高亮 / 面包屑用）
 * @param {boolean} opts.writable 能不能写（只有 dsh 真源可以；IDE 镜像是只读对账视图）
 * @param {object} opts.boot 交给客户端的第一屏数据（会序列化进内联脚本）
 */
export function renderMediaPage(opts) {
	const { views, facets, stats, filter, writable, root, dbPath, via, toolsRegistered, sync, error, boot } = opts;
	const boards = (facets?.boards ?? []).map(b => b.name);
	const tags = facets?.tags ?? [];
	const providers = facets?.providers ?? [];
	const kindCount = Object.fromEntries((facets?.kinds ?? []).map(k => [k.name, k.n]));

	const sideHtml = `<aside class="m-side" data-vssaros-media-side>`
		+ '<div class="m-sec">快捷</div>'
		+ navHtml({ key: 'all', label: '全部', count: stats.assetCount, icon: '▤', active: filter.nav === 'all' })
		+ navHtml({ key: 'kind:image', label: '图片', count: kindCount.image ?? stats.byKind?.image ?? 0, icon: '▣', active: filter.nav === 'kind:image' })
		+ navHtml({ key: 'kind:video', label: '视频', count: kindCount.video ?? stats.byKind?.video ?? 0, icon: '▶', active: filter.nav === 'kind:video' })
		+ navHtml({ key: 'kind:audio', label: '音频', count: kindCount.audio ?? stats.byKind?.audio ?? 0, icon: '♪', active: filter.nav === 'kind:audio' })
		+ navHtml({ key: 'kind:text', label: '文本', count: kindCount.text ?? stats.byKind?.text ?? 0, icon: '¶', active: filter.nav === 'kind:text' })
		+ navHtml({ key: 'favorite', label: '收藏', count: facets?.favorite ?? 0, icon: '★', active: filter.nav === 'favorite' })
		+ navHtml({ key: 'unclassified', label: '未分类', count: facets?.unclassified ?? 0, icon: '◌', active: filter.nav === 'unclassified' })
		+ navHtml({ key: 'untagged', label: '未标签', count: facets?.untagged ?? 0, icon: '◇', active: filter.nav === 'untagged' })
		+ navHtml({ key: 'trash', label: '回收站', count: facets?.deleted ?? stats.deletedCount, icon: '⌫', active: filter.nav === 'trash' })
		+ '<div class="m-sec">分组</div>'
		+ ((facets?.boards?.length ?? 0)
			? facets.boards.slice(0, 40).map(b => navHtml({
				key: `board:${b.name}`, label: b.name, count: b.n, icon: '▸', active: filter.nav === `board:${b.name}`,
			})).join('')
			: '<div class="m-dim" style="padding:2px 12px 4px">（还没有分组；在检查器里填「分组」即可新建，之后可拖拽归类）</div>')
		+ '<div class="m-sec">标签</div>'
		+ ((tags.length)
			? tags.slice(0, 40).map(t => navHtml({
				key: `tag:${t.name}`, label: `#${t.name}`, count: t.n, icon: '#', active: filter.nav === `tag:${t.name}`,
			})).join('')
			: '<div class="m-dim" style="padding:2px 12px 4px">（还没有标签）</div>')
		+ '</aside>';

	const kindChips = [['', '全部'], ['image', '图片'], ['video', '视频'], ['audio', '音频'], ['text', '文本']]
		.map(([v, label]) => `<button type="button" class="m-chip${(filter.kind || '') === v ? ' on' : ''}" data-kind="${v}">${label}</button>`)
		.join('');
	const providerChips = [['', '全部']].concat(providers.map(p => [p.name, p.name]))
		.map(([v, label]) => `<button type="button" class="m-chip${(filter.provider || '') === v ? ' on' : ''}" data-provider="${escapeHtml(v)}">${escapeHtml(label)}</button>`)
		.join('');

	const mainHtml = `<section class="m-main">`
		+ '<div class="m-top">'
		+ `<div class="m-crumb">媒体库<span class="sep">/</span><b data-vssaros-media-crumb>${escapeHtml(filter.label)}</b>`
		+ `<span class="cnt" data-vssaros-media-crumb-count>${escapeHtml(String(stats.assetCount))} 项</span></div>`
		+ '<div class="m-grow"></div>'
		+ '<button type="button" class="m-btn sm m-side-toggle" data-media-side-toggle title="导航">☰</button>'
		+ '<div class="m-search"><span>⌕</span><input type="search" name="q" data-media-search placeholder="搜索名称 / 标签 / prompt"'
		+ ` value="${escapeHtml(filter.query || '')}"></div>`
		+ '<div class="m-seg" data-media-view>'
		+ '<button type="button" class="on" data-mode="grid" title="网格">▦</button>'
		+ '<button type="button" data-mode="masonry" title="瀑布流">▥</button>'
		+ '<button type="button" data-mode="list" title="列表">≡</button>'
		+ '</div>'
		+ '<input type="range" class="m-density" name="density" data-media-density min="112" max="248" value="168" title="缩略图大小">'
		+ '<button type="button" class="m-btn sm" data-media-insp-toggle title="显示/隐藏检查器">⧉</button>'
		+ '<button type="button" class="m-btn sm" data-vssaros-media-open title="在编辑区打开（只有侧栏太窄时用）">↗ 编辑区</button>'
		+ '</div>'
		+ '<div class="m-chips">'
		+ '<span class="glabel">类型</span>' + kindChips
		+ '<span class="vsep"></span><span class="glabel">来源</span>' + providerChips
		+ '<span class="vsep"></span>'
		+ `<button type="button" class="m-chip${filter.favorite ? ' on' : ''}" data-fav="1">★ 仅收藏</button>`
		// ★ 2026-10-26：右端三个动作（放在这一行而不是顶栏 —— 顶栏已经满，这行本来就能横向滚）
		+ '<div class="m-grow"></div>'
		+ (writable ? '<button type="button" class="m-btn sm" data-media-import="file" title="从本地选图片/视频导入（可多选）">＋ 导入文件</button>' : '')
		+ (writable ? '<button type="button" class="m-btn sm" data-media-import="folder" title="导入整个文件夹（含子目录）">📁 导入文件夹</button>' : '')
		+ '<button type="button" class="m-btn sm" data-media-assistant title="叫「媒体库管家」来帮你找素材 / 整理素材">✨ AI 助手</button>'
		+ '<button type="button" class="m-btn sm" data-media-external title="在浏览器里打开这个媒体库（服务端现签带登录的链接）">↗ 外开</button>'
		+ '</div>'
		+ (writable ? '' : '<div class="m-banner">只读视图：这是 IDE 侧旧库的镜像（对账用）。写入请用默认的 dsh 真源。</div>')
		+ (error ? `<div class="m-banner">读取媒体库失败：${escapeHtml(error)}</div>` : '')
		+ `<div class="m-list mode-grid" data-vssaros-media-list>`
		+ (views.length
			? `<div class="m-cards">${views.map(cardHtml).join('')}</div>`
			: '<div class="m-empty">这个范围下没有素材（生图或导入后会出现在这里）。</div>')
		+ '</div>'
		+ '<div class="m-status">'
		+ `<span><b data-media-count>${escapeHtml(String(views.length))}</b> / ${escapeHtml(String(stats.assetCount))} 项</span><span>·</span>`
		+ '<span>已选 <b data-media-sel>0</b></span><span>·</span>'
		+ `<span>${escapeHtml(formatBytes(stats.totalBytes))} · 回收站 ${escapeHtml(String(stats.deletedCount))}</span>`
		+ '<div class="m-grow"></div>'
		// ★ 2026-10-26：「清空回收站」只在回收站视图出现（照 Eagle 的回收站工具条）；
		//   「清理孤儿文件」= objects/thumbs 里没有任何行引用的残留（IDE 侧那套 cleanOrphaned 的对应物）。
		+ (writable ? '<button type="button" class="m-btn sm danger" data-media-purge-deleted hidden>清空回收站</button>' : '')
		+ (writable ? '<button type="button" class="m-btn sm" data-media-clean-orphans title="删掉 objects/thumbs 里没有任何资产引用的残留文件">清理孤儿文件</button>' : '')
		+ '<button type="button" class="m-btn sm" data-media-more>加载更多</button>'
		// 两个隐藏 input：浏览器原生选择器（文件 / 文件夹），不需要宿主对话框
		+ '<input type="file" multiple hidden data-media-file-input accept="image/*,video/*,audio/*,.txt,.md,.json">'
		+ '<input type="file" multiple hidden data-media-folder-input webkitdirectory directory accept="image/*,video/*,audio/*,.txt,.md,.json">'
		+ '</div>'
		+ '</section>';

	const inspHtml = `<aside class="m-insp" data-vssaros-media-insp>${inspectorHtml(views[0], { writable, boards })}</aside>`;

	const bodyHtml = `<div class="m-app" data-vssaros-media-app style="position:relative">`
		+ sideHtml + mainHtml + inspHtml
		+ '<div class="m-batch" data-media-batch>'
		+ '<span>已选 <b data-media-batch-n>0</b> 项</span>'
		+ '<button type="button" class="m-btn sm" data-batch="favorite">★ 收藏</button>'
		+ '<button type="button" class="m-btn sm" data-batch="unfavorite">☆ 取消收藏</button>'
		+ '<button type="button" class="m-btn sm" data-batch="delete">⌫ 回收站</button>'
		+ '<button type="button" class="m-btn sm" data-batch="restore">↺ 恢复</button>'
		+ '<span class="m-dim" data-media-batch-progress></span>'
		+ '<button type="button" class="m-btn sm" data-media-batch-clear>取消</button>'
		+ '</div>'
		+ '<div class="m-up" data-media-upload></div>'
		+ '</div>';

	// ★ 诊断锚点（探针按名字取值；客户端刷新后不会丢，因为只在 SSR 里出现一次）
	const diag = `<div class="m-diag" data-vssaros-media-diag`
		+ ` data-vssaros-media-assets="${escapeHtml(String(stats.assetCount))}"`
		+ ` data-vssaros-media-deleted="${escapeHtml(String(stats.deletedCount))}"`
		+ ` data-vssaros-media-bytes="${escapeHtml(String(stats.totalBytes))}"`
		+ ` data-vssaros-media-kind="${escapeHtml(filter.kind || 'all')}"`
		+ ` data-vssaros-media-count="${escapeHtml(String(views.length))}"`
		+ ` data-vssaros-media-dir="${escapeHtml(dbPath)}"`
		+ ` data-vssaros-media-via="${escapeHtml(via)}"`
		+ ` data-vssaros-media-sync="${escapeHtml(String(sync?.imported ?? ''))}"`
		+ ` data-vssaros-media-writable="${writable ? '1' : '0'}"`
		+ ` data-vssaros-media-thumb="${escapeHtml(boot.thumbMode)}"`
		+ ` data-vssaros-media-tools="${escapeHtml(toolsRegistered)}"></div>`;

	// 内联脚本只做两件事：① 交出第一屏数据；② 「在编辑区打开」的桥退化链
	//   （⚠ 桥调用必须是 `bridge.openMediaGallery()` / `bridge.openModulePage(location.pathname)`
	//     这个字面形态 —— `dshPageCommandWiring.test.ts` ③ 按字面采集，改名 = 接线落进盲区）。
	const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
	const inlineScript = `window.__VSSAROS_MEDIA_BOOT__=${bootJson};`
		+ '(function(){'
		+ "var btn=document.querySelector('[data-vssaros-media-open]');if(!btn){return;}"
		+ "if(/(?:^|[?&])surface=editor(?:&|$)/.test(location.search)){btn.remove();return;}"
		+ "btn.addEventListener('click',function(ev){"
		+ 'if(ev&&ev.preventDefault){ev.preventDefault();}'
		+ "btn.classList.add('busy');btn.textContent='正在打开…';"
		+ 'var bridge=window.vssarosDsh;'
		+ "if(bridge&&typeof bridge.openMediaGallery==='function'){try{bridge.openMediaGallery();return;}catch(e){}}"
		+ "if(bridge&&typeof bridge.openModulePage==='function'){try{bridge.openModulePage(location.pathname);return;}catch(e){}}"
		+ 'if(bridge){location.href=location.pathname;return;}'
		+ "window.open(location.pathname,'_blank','noopener');"
		+ '});})();';

	return renderShell({
		kind: 'media',
		title: '媒体库',
		// 顶栏自带面包屑 + 搜索 ⇒ 外壳标题行只留一个占位（不然垂直空间白花 8px 且出现两个标题）
		headerHtml: '<div hidden></div>',
		bodyHtml: bodyHtml + diag + '<script src="app.js" defer></script>',
		attrs: `data-vssaros-media-root="${escapeHtml(root)}"`,
		extraCss: MEDIA_CSS,
		script: inlineScript,
	});
}
