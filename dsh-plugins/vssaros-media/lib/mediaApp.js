// @vssaros/dsh-media — 媒体库页面脚本（2026-10-26 改版 A 案）。由 `/x/media/app.js` 单独下发。
//
// 为什么单独一个文件而不是内联进页面 HTML：
//   ① 这份是**真正的 .js**，不受模板字符串（反引号 / `${`）影响 —— 本仓踩过"模板里一个反引号
//      把整页脚本截断 ⇒ 所有按钮静默失灵"（README 5.119 / `feedback_client_css_template_backtick`）；
//   ② 页面 HTML 只留一小段内联脚本（首屏数据 + 桥退化链），探针那条"内联脚本必须能解析"仍然有效，
//      这里另有一条"app.js 也能解析"的断言（p3-37）。
//
// 口径（与 mediaPage.js 的服务端渲染一致，改一个要改两个）：
//   · 左栏 nav key → list 查询参数；
//   · 写操作全部走 `/x/media/api/{favorite,tags,board,note,delete,restore}`（单条），
//     批量 = 前端 3 路并发 + 一次最多 20 条 + 进度与失败计数（用户拍板：不新增批量端点）；
//   · 缩略图：Host 没有编码器 ⇒ 页面首次渲染时用 canvas 缩到 256px 编 webp，
//     `POST /x/media/api/thumb/<id>` 落盘到 `media-store/thumbs/<sha8>.webp`，之后所有客户端命中缓存。
(function () {
	'use strict';

	var boot = window.__VSSAROS_MEDIA_BOOT__;
	if (!boot) { return; }

	var API = boot.api || '/x/media/api/';
	var KIND_GLYPH = { image: '▣', video: '▶', audio: '♪', text: '¶' };
	var BATCH_LIMIT = 20;   // 一次命令最多处理多少条（用户拍板）
	var BATCH_PARALLEL = 3; // 3 路并发（用户拍板）
	var THUMB_WIDTH = 256;

	var state = {
		source: boot.source,
		writable: boot.writable === true,
		facets: boot.facets || null,
		stats: boot.stats || { assetCount: 0, totalBytes: 0, deletedCount: 0, byKind: {} },
		views: (boot.views || []).slice(),
		byId: Object.create(null),
		sel: Object.create(null),
		lastId: null,
		// ★ 2026-10-27（用户报「标签点击添加/输入框回车没有反应」）：
		//   检查器首屏画的是 `views[0]`（SSR 口径），而那时 `state.lastId` 还是 null
		//   ⇒ 所有**以 lastId 为准**的写操作（加标签/移分组/存备注/收藏/删除）会**静默无反应**，
		//   直到用户先点一张卡。⇒ 单独记一个"检查器当前显示的那条"，写操作统一用它。
		inspId: null,
		mode: 'grid',
		offset: 0,
		limit: boot.limit || 60,
		total: boot.total || 0,
		filter: boot.filter || { nav: 'all', kind: '', provider: '', favorite: false, untagged: false, unclassified: false, deleted: false, query: '' },
		// 预览生成（图片缩略图 / 视频海报）：只在**可见**卡片上做，串行一条
		previewActive: 0,
		previewQueue: [],
		previewFailed: Object.create(null),
		// 反向同步（2026-10-27）：库的变更版本号 + 轮询定时器
		rev: 0,
		revTimer: 0,
	};
	for (var i = 0; i < state.views.length; i++) { state.byId[state.views[i].id] = state.views[i]; }

	var $ = function (sel, root) { return (root || document).querySelector(sel); };
	var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

	function esc(value) {
		return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
		});
	}
	function fmtBytes(n) {
		n = Number(n) || 0;
		if (n <= 0) { return '0 B'; }
		var units = ['B', 'KB', 'MB', 'GB'];
		var v = n;
		var i = 0;
		while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
		return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
	}
	function fmtTime(ms) {
		var n = Number(ms);
		if (!n) { return '未知'; }
		var d = new Date(n);
		var pad = function (v) { return String(v).padStart(2, '0'); };
		return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
	}
	function dimText(v) { return v.width && v.height ? v.width + '×' + v.height : '—'; }

	// ── 网络 ────────────────────────────────────────────────────────────────
	function jsonFetch(url, options) {
		var opts = Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {});
		return fetch(url, opts).then(function (res) {
			return res.json().catch(function () { return { ok: false, error: 'HTTP ' + res.status }; })
				.then(function (body) {
					if (!res.ok || body.ok === false) { throw new Error(body && body.error ? body.error : ('HTTP ' + res.status)); }
					return body;
				});
		});
	}
	function postJson(name, payload) {
		return jsonFetch(API + name, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload || {}),
		});
	}

	/** 当前筛选 → `/api/list` 的查询串。 */
	function queryOf(filter, offset, limit) {
		var q = [];
		if (filter.kind) { q.push('kind=' + encodeURIComponent(filter.kind)); }
		if (filter.provider) { q.push('provider=' + encodeURIComponent(filter.provider)); }
		if (filter.favorite) { q.push('favorite=1'); }
		if (filter.untagged) { q.push('untagged=1'); }
		if (filter.unclassified) { q.push('unclassified=1'); }
		if (filter.deleted) { q.push('deleted=1'); }
		if (filter.board) { q.push('board=' + encodeURIComponent(filter.board)); }
		if (filter.tag) { q.push('tag=' + encodeURIComponent(filter.tag)); }
		if (filter.query) { q.push('query=' + encodeURIComponent(filter.query)); }
		q.push('limit=' + limit);
		if (offset) { q.push('offset=' + offset); }
		return q.join('&');
	}

	/** 名字兜底（与 mediaPage.displayNameOf 同口径）：文件名 → 路径 basename → ref 里的文件名 → prompt → id 前 8 位。 */
	function displayNameOf(asset) {
		var name = String(asset.fileName || asset.name || '').trim();
		if (name) { return name; }
		var fromPath = function (value) {
			var text = String(value || '').trim();
			if (!text) { return ''; }
			var parts = text.split(/[\\/]/).filter(Boolean);
			var base = parts.length ? parts[parts.length - 1] : '';
			return base.replace(/\?.*$/, '');
		};
		var refText = String(asset.ref || '');
		var m = /[?&]filename=([^&]+)/.exec(refText);
		if (m && m[1]) {
			try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
		}
		var fromFile = fromPath(asset.filePath) || fromPath(refText);
		if (fromFile) { return fromFile; }
		var prompt = String(asset.prompt || '').trim();
		if (prompt) { return prompt.length > 24 ? prompt.slice(0, 24) + '…' : prompt; }
		return String(asset.id || '').slice(0, 8);
	}

	/** 把接口返回的原始资产折成视图（与 mediaPage.toView 同口径）。 */
	function toView(asset) {
		var id = String(asset.id || '');
		var kind = String(asset.kind || 'image');
		var hasBytes = state.source === 'dsh' ? !!asset.filePath : false;
		var hasThumb = state.source === 'dsh' && asset.hasThumb === true;
		// 与 mediaPage.toView 同口径：非图片不拿原始字节当图（79 条视频塞 <img> 会拉整段视频 ⇒ 卡死）
		var imgUrl = hasThumb
			? API + 'thumb/' + encodeURIComponent(id)
			: (kind === 'image' && hasBytes ? API + 'bytes/' + encodeURIComponent(id) : '');
		return {
			id: id,
			kind: kind,
			kindLabel: ({ image: '图片', video: '视频', audio: '音频', text: '文本' })[kind] || kind,
			name: displayNameOf(asset),
			sizeBytes: Number(asset.bytes || asset.sizeBytes || 0) || 0,
			createdAt: Number(asset.createdAt || 0) || 0,
			favorite: asset.favorite === true,
			board: asset.board ? String(asset.board) : '',
			tags: Array.isArray(asset.tags) ? asset.tags.map(String) : [],
			note: asset.note ? String(asset.note) : '',
			width: Number(asset.width || 0) || 0,
			height: Number(asset.height || 0) || 0,
			provider: asset.provider ? String(asset.provider) : '',
			mime: asset.mime ? String(asset.mime) : '',
			ext: asset.ext ? String(asset.ext) : '',
			prompt: asset.prompt ? String(asset.prompt) : '',
			sha8: asset.sha8 ? String(asset.sha8) : '',
			imgUrl: imgUrl,
			hasThumb: hasThumb,
			hasBytes: hasBytes,
			filePath: asset.filePath ? String(asset.filePath) : '',
			deleted: asset.isDeleted === true || asset.deleted === true,
		};
	}

	function listParams(filter) {
		return {
			kind: filter.kind || undefined,
			provider: filter.provider || undefined,
			board: filter.board || undefined,
			tag: filter.tag || undefined,
			query: filter.query || undefined,
			favorite: filter.favorite === true || undefined,
			untagged: filter.untagged === true || undefined,
			unclassified: filter.unclassified === true || undefined,
			onlyDeleted: filter.deleted === true || undefined,
		};
	}

	// ── 渲染 ────────────────────────────────────────────────────────────────
	function cardHtml(v) {
		var img = v.imgUrl
			? '<img src="' + esc(v.imgUrl) + '" alt="" loading="lazy" decoding="async" data-vssaros-media-img>'
			: '<span class="m-glyph">' + (KIND_GLYPH[v.kind] || '▣') + '</span>';
		var meta = [dimText(v), v.sizeBytes ? fmtBytes(v.sizeBytes) : ''].filter(Boolean).join(' · ');
		var ar = v.width && v.height ? (v.width + '/' + v.height) : '';
		return '<button type="button" class="m-card' + (state.sel[v.id] ? ' sel' : '') + '" data-id="' + esc(v.id) + '"'
			+ ' data-kind="' + esc(v.kind) + '" title="' + esc(v.name) + '" draggable="' + (state.writable ? 'true' : 'false') + '">'
			+ '<span class="m-thumb" data-ar="' + esc(ar) + '">' + img
			+ '<span class="m-kbadge">' + esc(v.kindLabel) + '</span>'
			+ (v.favorite ? '<span class="m-fav" title="已收藏">★</span>' : '')
			+ '<span class="m-check">✓</span>'
			+ '</span>'
			+ '<span class="m-name">' + esc(v.name) + '</span>'
			+ '<span class="m-meta">' + esc(meta) + '</span>'
			+ '</button>';
	}

	function renderList() {
		var host = $('[data-vssaros-media-list]');
		if (!host) { return; }
		host.className = 'm-list mode-' + state.mode;
		host.innerHTML = state.views.length
			? '<div class="m-cards">' + state.views.map(cardHtml).join('') + '</div>'
			: '<div class="m-empty">这个范围下没有素材（生图或导入后会出现在这里）。</div>';
		applyMasonryRatios();
		$('[data-media-count]').textContent = String(state.views.length);
		$('[data-media-sel]').textContent = String(Object.keys(state.sel).length);
		var more = $('[data-media-more]');
		if (more) { more.style.display = state.views.length < state.total ? '' : 'none'; }
		observePreviews();
	}

	/**
	 * 只同步"选中态"（不重建卡片）。
	 * ★ 2026-10-26（真机卡顿）：原来点一张卡就 `renderAll()` ⇒ 60 张卡的 DOM 全重建、
	 *   所有 `<img>` 重新挂载解码。选中只是加个 class，不该付这个代价。
	 */
	function renderSelection() {
		var selCount = 0;
		$$('.m-card').forEach(function (el) {
			var on = !!state.sel[el.getAttribute('data-id')];
			el.classList.toggle('sel', on);
			if (on) { selCount++; }
		});
		var counter = $('[data-media-sel]');
		if (counter) { counter.textContent = String(selCount); }
	}

	/** 写操作后只换**那一张**卡（保留选中态与占位）。 */
	function patchCard(id) {
		var v = state.byId[id];
		if (!v) { return; }
		var el = $('.m-card[data-id="' + CSS.escape(String(id)) + '"]');
		if (!el) { return; }
		var html = cardHtml(v);
		var holder = document.createElement('div');
		holder.innerHTML = html;
		var next = holder.firstElementChild;
		if (!next) { return; }
		el.replaceWith(next);
		observePreviews();
	}

	/** 瀑布流：给每张缩略图贴回它自己的宽高比（网格模式一律 1:1）。 */
	function applyMasonryRatios() {
		var on = state.mode === 'masonry';
		$$('[data-vssaros-media-list] .m-thumb').forEach(function (el) {
			var ar = el.getAttribute('data-ar');
			if (on && ar) { el.style.aspectRatio = ar.replace('/', ' / '); } else { el.style.aspectRatio = ''; }
		});
	}

	function tagsHtml(v) {
		if (!v.tags.length) { return '<span class="m-dim">（无标签）</span>'; }
		return v.tags.map(function (t) {
			return '<span class="m-tg" data-tag="' + esc(t) + '">#' + esc(t)
				+ (state.writable ? '<i class="m-tgx" data-tag-del="' + esc(t) + '" title="移除标签">×</i>' : '')
				+ '</span>';
		}).join('');
	}

	/** 已有分组的名单（datalist 的候选；输入框里手输新名字即新建）。 */
	function boardListHtml(v) {
		var boards = (state.facets && state.facets.boards ? state.facets.boards : []).map(function (b) { return b.name; });
		if (v.board && boards.indexOf(v.board) < 0) { boards.push(v.board); }
		return boards.map(function (b) { return '<option value="' + esc(b) + '"></option>'; }).join('');
	}

	/**
	 * 应用「分组」输入框的值（回车或失焦都会走这里）。
	 * 空 = 未分组；**手输新名字 = 新建分组**（服务端 `setBoard` 直接接受新名字）。
	 */
	function applyBoardInput(input) {
		var id = inspId();
		if (!id || !input) { return; }
		var name = String(input.value || '').trim();
		var cur = state.byId[id] ? String(state.byId[id].board || '') : '';
		if (name === cur) { return; }
		setBoard(id, name).catch(function (e) { toast('移动分组失败：' + e.message); });
	}

	/**
	 * **检查器当前显示的那条素材 id**（写操作的唯一目标）。
	 *
	 * ★ 2026-10-27（用户报「标签点添加/回车没反应」的根因）：
	 *   检查器首屏显示的是 `views[0]`（SSR 画的），但写操作全按 `state.lastId` 取
	 *   ⇒ 用户**没点过卡**时 lastId 是 null ⇒ 加标签/移分组/存备注/收藏/删除全部**静默无反应**。
	 *   这里统一取"检查器正在显示的那条"，与用户眼前的界面一致。
	 */
	function inspId() {
		return state.inspId || state.lastId || (state.views[0] && state.views[0].id) || '';
	}

	function renderInspector() {
		var host = $('[data-vssaros-media-insp]');
		if (!host) { return; }
		var v = state.lastId ? state.byId[state.lastId] : state.views[0];
		if (!v) { host.innerHTML = '<div class="m-empty">未选中资产</div>'; state.inspId = null; return; }
		// 检查器当前显示的那条（写操作的唯一目标）—— 与首屏 SSR 口径一致
		state.inspId = v.id;
		var pv = v.imgUrl
			? '<img src="' + esc(v.imgUrl) + '" alt="" data-vssaros-media-insp-img>'
			: '<span class="m-glyph big">' + (KIND_GLYPH[v.kind] || '▣') + '</span>';
		var ro = state.writable ? '' : ' disabled';
		host.innerHTML = '<div class="m-pv">' + pv + '</div>'
			+ '<h4 class="m-iname" data-vssaros-media-insp-name>' + esc(v.name) + '</h4>'
			+ '<div class="m-isub">' + esc(v.kindLabel)
			+ (v.mime ? ' · ' + esc(v.mime) : '') + (v.sizeBytes ? ' · ' + fmtBytes(v.sizeBytes) : '')
			+ (v.favorite ? ' · ★ 已收藏' : '') + '</div>'
			+ '<div class="m-blk"><div class="m-bh">元信息</div><dl class="m-kv">'
			+ '<dt>尺寸</dt><dd>' + esc(dimText(v)) + '</dd>'
			+ '<dt>格式</dt><dd>' + esc((v.ext || '—').toUpperCase()) + '</dd>'
			+ '<dt>大小</dt><dd>' + esc(fmtBytes(v.sizeBytes)) + '</dd>'
			+ '<dt>来源</dt><dd>' + esc(v.provider || '—') + '</dd>'
			+ '<dt>导入</dt><dd>' + esc(fmtTime(v.createdAt)) + '</dd>'
			+ '</dl></div>'
			+ '<div class="m-blk"><div class="m-bh">分组</div>'
			// ★ 2026-10-27：分组改成**可输入的 combo**（input + datalist）——
			//   以前只有下拉框 ⇒ 没法新建分组（左栏空态提示却写着"在检查器里填「分组」即可新建"）。
			+ '<input class="m-input" name="board" data-insp-board list="vssaros-media-boards" value="' + esc(v.board || '') + '" placeholder="分组（回车应用；输入新名字即新建）"' + ro + '>'
			+ '<datalist id="vssaros-media-boards">' + boardListHtml(v) + '</datalist></div>'
			+ '<div class="m-blk"><div class="m-bh">标签</div><div class="m-tags" data-insp-tags>' + tagsHtml(v) + '</div>'
			+ (state.writable ? '<div class="m-tagadd"><input class="m-input" name="tag" data-insp-taginput placeholder="加标签后回车" maxlength="24">'
				+ '<button type="button" class="m-btn sm" data-insp-tagadd>+ 添加</button></div>' : '')
			+ '</div>'
			+ '<div class="m-blk"><div class="m-bh">注释</div>'
			+ (state.writable
				? '<textarea class="m-input m-note" name="note" data-insp-note rows="3" placeholder="这张素材的备注（自动保存）">' + esc(v.note) + '</textarea>'
				: '<div class="m-dim">' + esc(v.note || '（无）') + '</div>')
			+ '</div>'
			+ (v.prompt ? '<div class="m-blk"><div class="m-bh">Prompt</div><div class="m-prompt">' + esc(v.prompt) + '</div></div>' : '')
			+ '<div class="m-acts">'
			+ '<button type="button" class="m-btn primary" data-act="fav">' + (v.favorite ? '★ 取消收藏' : '☆ 收藏') + '</button>'
			+ (state.writable
				? (v.deleted
					? '<button type="button" class="m-btn" data-act="restore">↺ 恢复</button>'
					+ '<button type="button" class="m-btn danger" data-act="purge" title="物理删除这一行和它的文件（不可恢复）">⨯ 永久删除</button>'
					: '<button type="button" class="m-btn danger" data-act="delete">⌫ 移入回收站</button>')
				: '')
			+ '</div>';
	}

	/** 左栏计数（facets 变了就重绘计数，不动 DOM 结构）。 */
	function renderSide() {
		var facets = state.facets;
		if (!facets) { return; }
		var map = {
			'all': state.stats.assetCount,
			'favorite': facets.favorite,
			'unclassified': facets.unclassified,
			'untagged': facets.untagged,
			'trash': facets.deleted,
		};
		(facets.kinds || []).forEach(function (k) { map['kind:' + k.name] = k.n; });
		(facets.boards || []).forEach(function (b) { map['board:' + b.name] = b.n; });
		(facets.tags || []).forEach(function (t) { map['tag:' + t.name] = t.n; });
		$$('[data-nav]').forEach(function (btn) {
			var n = map[btn.getAttribute('data-nav')];
			var badge = btn.querySelector('.n');
			if (badge && n !== undefined) { badge.textContent = String(n); }
		});
		// ★ 2026-10-27（用户报「添加标签后左侧栏的标签分组未刷新」）：
		//   上面只改**已有项**的计数，而「分组 / 标签」两段是 **SSR 画的**（mediaPage.js 的 sideHtml）
		//   ⇒ 新加的标签/分组在左栏**永远不出现**，直到整页刷新 ⇒ 这里把这两段**重建**。
		rebuildSideSection('分组', (facets.boards || []).slice(0, 40).map(function (b) {
			return { key: 'board:' + b.name, label: b.name, count: b.n, icon: '▸', active: state.filter.nav === 'board:' + b.name };
		}), '（还没有分组；在检查器里填「分组」即可新建，之后可拖拽归类）');
		rebuildSideSection('标签', (facets.tags || []).slice(0, 40).map(function (t) {
			return { key: 'tag:' + t.name, label: '#' + t.name, count: t.n, icon: '#', active: state.filter.nav === 'tag:' + t.name };
		}), '（还没有标签）');
	}

	/**
	 * 重建左栏某一段（`.m-sec` 标题之后、下一个 `.m-sec` 之前的那批 nav 节点）。
	 *
	 * ★ 用**现有 nav 节点做模板**克隆，而不是在客户端重写一遍 markup ——
	 *   两边写死同一份结构必然漂（这个仓已经吃过好几次"服务端/客户端两份口径"的亏）。
	 */
	function rebuildSideSection(secText, items, emptyText) {
		var side = $('[data-vssaros-media-side]');
		if (!side) { return; }
		var secs = $$('.m-sec', side);
		var sec = null;
		for (var i = 0; i < secs.length; i++) {
			if (secs[i].textContent.trim() === secText) { sec = secs[i]; break; }
		}
		if (!sec) { return; }
		var template = side.querySelector('.m-nav');
		if (!template) { return; }
		// 先摘掉这一段的旧节点（模板要在这之前拿到 —— 它在「快捷」段里，安全）
		var node = sec.nextElementSibling;
		while (node && !node.classList.contains('m-sec')) {
			var nx = node.nextElementSibling;
			node.remove();
			node = nx;
		}
		var frag = document.createDocumentFragment();
		if (!items.length) {
			var empty = document.createElement('div');
			empty.className = 'm-dim';
			empty.style.padding = '2px 12px 4px';
			empty.textContent = emptyText;
			frag.appendChild(empty);
		} else {
			for (var j = 0; j < items.length; j++) {
				var it = items[j];
				var btn = template.cloneNode(true);
				btn.setAttribute('data-nav', it.key);
				btn.setAttribute('title', it.label);
				var lb = btn.querySelector('.lb');
				if (lb) { lb.textContent = it.label; }
				var ic = btn.querySelector('.ic');
				if (ic && it.icon) { ic.textContent = it.icon; }
				var n = btn.querySelector('.n');
				if (n) { n.textContent = String(it.count == null ? 0 : it.count); }
				if (it.active) { btn.classList.add('on'); } else { btn.classList.remove('on'); }
				frag.appendChild(btn);
			}
		}
		sec.parentNode.insertBefore(frag, sec.nextSibling);
	}

	function renderChips() {
		$$('[data-kind]').forEach(function (btn) {
			btn.classList.toggle('on', (btn.getAttribute('data-kind') || '') === (state.filter.kind || ''));
		});
		$$('[data-provider]').forEach(function (btn) {
			btn.classList.toggle('on', (btn.getAttribute('data-provider') || '') === (state.filter.provider || ''));
		});
		var fav = $('[data-fav]');
		if (fav) { fav.classList.toggle('on', state.filter.favorite === true); }
		var crumb = $('[data-vssaros-media-crumb]');
		if (crumb) { crumb.textContent = state.filter.label || '全部'; }
		var cnt = $('[data-vssaros-media-crumb-count]');
		if (cnt) { cnt.textContent = state.total + ' 项'; }
	}

	function renderBatch() {
		var bar = $('[data-media-batch]');
		if (!bar) { return; }
		var n = Object.keys(state.sel).length;
		bar.classList.toggle('on', n > 0);
		var count = $('[data-media-batch-n]');
		if (count) { count.textContent = String(n); }
	}

	/** 「清空回收站」只在回收站视图出现（与 SSR 的 `hidden` 初值一致）。 */
	function renderTrashTools() {
		var btn = $('[data-media-purge-deleted]');
		if (!btn) { return; }
		if (state.filter.deleted === true) { btn.removeAttribute('hidden'); }
		else { btn.setAttribute('hidden', ''); disarm(btn); if (armedButton === btn) { armedButton = null; } }
	}

	function renderAll() { renderList(); renderInspector(); renderSide(); renderChips(); renderBatch(); renderTrashTools(); }

	// ── 筛选 / 载入 ──────────────────────────────────────────────────────────
	var toastTimer = 0;
	function toast(text) {
		var el = $('[data-media-batch-progress]') || $('[data-media-toast]');
		if (!el) { return; }
		el.textContent = text;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(function () { el.textContent = ''; }, 4000);
	}

	function reload(keepSelection) {
		var filter = state.filter;
		var url = API + 'list?' + queryOf(filter, 0, state.limit);
		return jsonFetch(url).then(function (body) {
			state.views = body.items.map(toView);
			state.total = Number(body.total || state.views.length);
			state.offset = state.views.length;
			state.byId = Object.create(null);
			state.views.forEach(function (v) { state.byId[v.id] = v; });
			if (!keepSelection) { state.sel = Object.create(null); state.lastId = null; }
			renderAll();
			toast('');
			// 自己这次重载已经把最新状态画出来了 ⇒ 把基线抬上去，别让轮询再刷一次
			markRev();
		}).catch(function (e) {
			toast('读取失败：' + (e && e.message ? e.message : e));
		});
	}

	function loadMore() {
		var url = API + 'list?' + queryOf(state.filter, state.offset, state.limit);
		return jsonFetch(url).then(function (body) {
			var more = body.items.map(toView);
			state.views = state.views.concat(more);
			state.offset = state.views.length;
			more.forEach(function (v) { state.byId[v.id] = v; });
			renderList();
		}).catch(function (e) { toast('加载更多失败：' + (e && e.message ? e.message : e)); });
	}

	function refreshFacets() {
		if (state.source !== 'dsh') { return Promise.resolve(); }
		return jsonFetch(API + 'facets').then(function (body) {
			state.facets = body.facets;
			renderSide();
			renderInspector();
		}).catch(function () { /* 聚合计数拿不到不影响主流程 */ });
	}

	function refreshStats() {
		if (state.source !== 'dsh') { return Promise.resolve(); }
		return jsonFetch(API + 'stats').then(function (body) {
			var s = body.stats || {};
			state.stats = {
				assetCount: Number(s.live || 0),
				totalBytes: Number(s.bytes || 0),
				deletedCount: Number(s.total || 0) - Number(s.live || 0),
			};
		}).catch(function () { });
	}

	// ── 左栏导航 ────────────────────────────────────────────────────────────
	var NAV_LABEL = {
		all: '全部', favorite: '收藏', unclassified: '未分类', untagged: '未标签', trash: '回收站',
		'kind:image': '图片', 'kind:video': '视频', 'kind:audio': '音频', 'kind:text': '文本',
	};
	function applyNav(key, label) {
		var filter = { nav: key, kind: state.filter.kind, provider: state.filter.provider, favorite: false,
			untagged: false, unclassified: false, deleted: false, board: '', tag: '', query: state.filter.query };
		if (key === 'all') {
			// 全部：保留 chips 上的类型/来源（Eagle 的「全部图片」也吃筛选器）
		} else if (key.indexOf('kind:') === 0) {
			filter.kind = key.slice(5);
		} else if (key === 'favorite') {
			filter.favorite = true;
		} else if (key === 'unclassified') {
			filter.unclassified = true;
		} else if (key === 'untagged') {
			filter.untagged = true;
		} else if (key === 'trash') {
			filter.deleted = true;
		} else if (key.indexOf('board:') === 0) {
			filter.board = key.slice(6);
		} else if (key.indexOf('tag:') === 0) {
			filter.tag = key.slice(4);
		}
		filter.label = label || NAV_LABEL[key] || key;
		state.filter = filter;
		$$('[data-nav]').forEach(function (btn) { btn.classList.toggle('on', btn.getAttribute('data-nav') === key); });
		reload(false);
	}

	// ── 写操作 ──────────────────────────────────────────────────────────────
	function patchLocal(id, patch) {
		var v = state.byId[id];
		if (!v) { return null; }
		Object.keys(patch).forEach(function (k) { v[k] = patch[k]; });
		return v;
	}

	function setFavorite(id, value) {
		return postJson('favorite', { id: id, value: value }).then(function (body) {
			var asset = body.asset || {};
			patchLocal(id, { favorite: asset.favorite === true });
			// 只换这一张卡 + 检查器（不重建整个列表：60 张卡的 DOM/图片重挂代价太大）
			patchCard(id);
			renderInspector();
			return refreshFacets();
		});
	}

	function setTags(id, tags) {
		return postJson('tags', { id: id, tags: tags }).then(function (body) {
			var asset = body.asset || {};
			patchLocal(id, { tags: Array.isArray(asset.tags) ? asset.tags.map(String) : [] });
			patchCard(id);
			renderInspector();
			return refreshFacets();
		});
	}

	function setBoard(id, board) {
		return postJson('board', { id: id, board: board }).then(function (body) {
			var asset = body.asset || {};
			patchLocal(id, { board: asset.board ? String(asset.board) : '' });
			patchCard(id);
			renderInspector();
			return refreshFacets();
		});
	}

	function setNote(id, note) {
		return postJson('note', { id: id, note: note }).then(function (body) {
			var asset = body.asset || {};
			patchLocal(id, { note: asset.note ? String(asset.note) : '' });
			return null;
		});
	}

	function setDeleted(id, deleted) {
		return postJson(deleted ? 'delete' : 'restore', { id: id }).then(function (body) {
			var asset = body.asset || {};
			patchLocal(id, { deleted: asset.isDeleted === true });
			return refreshFacets().then(refreshStats);
		});
	}

	/**
	 * 批量：3 路并发、一次最多 20 条、带进度与失败计数（用户拍板：不新增批量端点）。
	 * @param {string[]} ids
	 * @param {(id: string) => Promise<any>} op
	 */
	function runBatch(ids, op, label) {
		var queue = ids.slice(0, BATCH_LIMIT);
		var skipped = ids.length - queue.length;
		var total = queue.length;
		var done = 0;
		var failed = 0;
		var show = function () {
			var el = $('[data-media-batch-progress]');
			if (el) {
				el.textContent = (label || '处理') + ' ' + done + '/' + total + ' · 失败 ' + failed
					+ (skipped > 0 ? ' · 跳过 ' + skipped + ' 条（一次最多 ' + BATCH_LIMIT + ' 条）' : '');
			}
		};
		show();
		var worker = function () {
			if (!queue.length) { return Promise.resolve(); }
			var id = queue.shift();
			return op(id).then(function () { done++; }, function () { failed++; }).then(function () {
				show();
				return worker();
			});
		};
		var workers = [];
		for (var i = 0; i < Math.min(BATCH_PARALLEL, total); i++) { workers.push(worker()); }
		return Promise.all(workers).then(function () {
			show();
			renderAll();
		});
	}

	// ── 预览（图片缩略图 / 视频海报：页面侧生成 + Host 落盘）──────────────────
	//
	// ★ 2026-10-26（真机两连击）：① 视频原来把 mp4 塞进 `<img>` ⇒ 不显示、还各拉一整段；
	//   ② 缩略图对**整个列表**一次性排队 ⇒ 几十个视频同时解码把页面顶死。
	//   现在：只有**接近视口**的卡片才做预览，串行一条，失败记下来不再重试（否则每次刷新重跑）。

	var previewObserver = null;

	/** 需要预览的资产：有字节、还没有缩略图/海报、类型受支持、之前没失败过。 */
	function needsPreview(v) {
		return !!v && !v.hasThumb && v.hasBytes && (v.kind === 'image' || v.kind === 'video')
			&& !state.previewFailed[v.id];
	}

	function ensurePreviewObserver() {
		if (previewObserver || typeof IntersectionObserver !== 'function') { return; }
		previewObserver = new IntersectionObserver(function (entries) {
			for (var i = 0; i < entries.length; i++) {
				var entry = entries[i];
				if (!entry.isIntersecting) { continue; }
				previewObserver.unobserve(entry.target);
				enqueuePreview(entry.target.getAttribute('data-id'));
			}
		}, { root: null, rootMargin: '320px' });
	}

	/** 渲染完列表后调：只把"可见附近"的卡片交给观察器。 */
	function observePreviews() {
		if (!state.writable || state.source !== 'dsh') { return; }
		ensurePreviewObserver();
		$$('[data-vssaros-media-list] .m-card').forEach(function (el) {
			var v = state.byId[el.getAttribute('data-id')];
			if (!needsPreview(v)) { return; }
			if (previewObserver) { previewObserver.observe(el); }
			else { enqueuePreview(v.id); }
		});
	}

	function enqueuePreview(id) {
		if (!id) { return; }
		if (!needsPreview(state.byId[id])) { return; }
		if (state.previewQueue.indexOf(id) >= 0) { return; }
		state.previewQueue.push(id);
		pumpPreviews();
	}

	function pumpPreviews() {
		if (!state.writable || state.source !== 'dsh') { return; }
		var headId = state.previewQueue[0];
		if (!headId) { return; }
		var head = state.byId[headId];
		if (!needsPreview(head)) { state.previewQueue.shift(); pumpPreviews(); return; }
		// 视频解码重 ⇒ 独占（同一时刻只解一个）；图片轻 ⇒ 最多 2 张并行
		var limit = head.kind === 'video' ? 1 : 2;
		if (state.previewActive >= limit) { return; }
		state.previewQueue.shift();
		state.previewActive++;
		makePreview(head)
			.catch(function () { state.previewFailed[headId] = true; })
			.then(function () { state.previewActive--; pumpPreviews(); });
	}

	/** 一张 webp（图片 = 缩到 256；视频 = 抓一帧当海报），POST 落盘后换上。 */
	function makePreview(v) {
		var source = v.kind === 'video' ? videoFrameSource(v) : imageSource(v);
		return source
			.then(function (res) { return canvasToWebp(res.canvas); })
			.then(function (webp) {
				if (!webp) { throw new Error('这个浏览器编不了 webp'); }
				return fetch(API + 'thumb/' + encodeURIComponent(v.id), {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'image/webp' },
					body: webp,
				});
			})
			.then(function (res) {
				if (!res.ok) { throw new Error('HTTP ' + res.status); }
				v.hasThumb = true;
				v.imgUrl = API + 'thumb/' + encodeURIComponent(v.id);
				swapPreviewInto(v);
			});
	}

	function imageSource(v) {
		// ★ 首屏那张图**已经在 DOM 里**了（SSR 对无缩略图的图片直接给了原图）⇒ 直接 drawImage 复用，
		//   别再 fetch 一遍（否则每张图首次加载会被下载两次：一次 `<img>`、一次生成缩略图）。
		//   ⚠ 只等它 `load`（同一个请求），**不要**在这里再发一次。
		var shown = $('.m-card[data-id="' + CSS.escape(String(v.id)) + '"] [data-vssaros-media-img]');
		if (shown) {
			return whenImageReady(shown)
				.then(function () {
					var canvas = scaleToCanvas(shown.naturalWidth, shown.naturalHeight, function (ctx, w, h) {
						ctx.drawImage(shown, 0, 0, w, h);
					});
					return { canvas: canvas };
				})
				.catch(function () { return fetchImageSource(v); });
		}
		return fetchImageSource(v);
	}

	/** 等一个已在 DOM 里的 `<img>` 解码完成（不发新请求）。 */
	function whenImageReady(img) {
		if (img.complete && img.naturalWidth > 0) { return Promise.resolve(); }
		return new Promise(function (resolve, reject) {
			var timer = setTimeout(function () { cleanup(); reject(new Error('图片加载超时')); }, 12000);
			function cleanup() {
				clearTimeout(timer);
				img.removeEventListener('load', onLoad);
				img.removeEventListener('error', onError);
			}
			function onLoad() { cleanup(); if (img.naturalWidth > 0) { resolve(); } else { reject(new Error('图片解码失败')); } }
			function onError() { cleanup(); reject(new Error('图片加载失败')); }
			img.addEventListener('load', onLoad);
			img.addEventListener('error', onError);
		});
	}

	function fetchImageSource(v) {
		return fetch(API + 'bytes/' + encodeURIComponent(v.id), { credentials: 'same-origin' })
			.then(function (res) { return res.ok ? res.blob() : Promise.reject(new Error('HTTP ' + res.status)); })
			.then(function (blob) { return createImageBitmap(blob); })
			.then(function (bitmap) {
				var canvas = scaleToCanvas(bitmap.width, bitmap.height, function (ctx, w, h) { ctx.drawImage(bitmap, 0, 0, w, h); });
				if (bitmap.close) { bitmap.close(); }
				return { canvas: canvas };
			});
	}

	/**
	 * 视频海报：拿 `<video>` 解一帧画到 canvas。
	 * ⚠ 必须 `muted` + 不 `play()`（自动播会被拦，且解码开销大）；`removeAttribute('src')` + `load()`
	 *   是把解码器还回去，不做的话几十个视频会把内存顶满。
	 */
	function videoFrameSource(v) {
		return new Promise(function (resolve, reject) {
			var video = document.createElement('video');
			video.preload = 'auto';
			video.muted = true;
			video.playsInline = true;
			var settled = false;
			var timer = setTimeout(function () { finish(new Error('取帧超时（15s）')); }, 15000);
			function finish(err, canvas) {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				try { video.removeAttribute('src'); video.load(); } catch (e) { /* 忽略 */ }
				if (err) { reject(err); } else { resolve({ canvas: canvas }); }
			}
			function draw() {
				try {
					var w = video.videoWidth || 320;
					var h = video.videoHeight || 180;
					finish(undefined, scaleToCanvas(w, h, function (ctx, cw, ch) { ctx.drawImage(video, 0, 0, cw, ch); }));
				} catch (e) { finish(e); }
			}
			video.onloadeddata = function () {
				try {
					var target = Math.min(0.2, Math.max(0, (Number(video.duration) || 1) * 0.05));
					if (Math.abs(video.currentTime - target) < 0.01) { draw(); } else { video.currentTime = target; }
				} catch (e) { finish(e); }
			};
			video.onseeked = function () { draw(); };
			video.onerror = function () { finish(new Error('视频解码失败')); };
			video.src = API + 'bytes/' + encodeURIComponent(v.id);
		});
	}

	function scaleToCanvas(width, height, draw) {
		var scale = Math.min(1, THUMB_WIDTH / (width || THUMB_WIDTH));
		var cw = Math.max(1, Math.round((width || THUMB_WIDTH) * scale));
		var ch = Math.max(1, Math.round((height || THUMB_WIDTH) * scale));
		var canvas = document.createElement('canvas');
		canvas.width = cw;
		canvas.height = ch;
		draw(canvas.getContext('2d'), cw, ch);
		return canvas;
	}

	function canvasToWebp(canvas) {
		return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/webp', 0.82); });
	}

	/** 把刚生成的预览就地换上（卡片 + 检查器），不重建列表。 */
	function swapPreviewInto(v) {
		// ★ SSR 首屏的检查器画的是 `views[0]`，而那时 `state.lastId` 还是 null ⇒ 这里要用同一个口径，
		//   否则"首屏默认选中的那条是视频"时，海报生成了检查器却一直显示字形。
		var selectedId = state.lastId || (state.views[0] && state.views[0].id);
		var thumb = $('.m-card[data-id="' + CSS.escape(String(v.id)) + '"] .m-thumb');
		if (thumb) {
			var img = thumb.querySelector('[data-vssaros-media-img]');
			if (!img) {
				img = document.createElement('img');
				img.setAttribute('data-vssaros-media-img', '');
				img.alt = '';
				img.setAttribute('decoding', 'async');
				var glyph = thumb.querySelector('.m-glyph');
				if (glyph) { glyph.replaceWith(img); } else { thumb.insertBefore(img, thumb.firstChild); }
			}
			img.src = v.imgUrl;
		}
		if (selectedId !== v.id) { return; }
		var insp = $('[data-vssaros-media-insp-img]');
		if (insp) { insp.src = v.imgUrl; return; }
		var bigGlyph = $('.m-pv .m-glyph');
		if (bigGlyph) {
			var newImg = document.createElement('img');
			newImg.setAttribute('data-vssaros-media-insp-img', '');
			newImg.alt = '';
			newImg.src = v.imgUrl;
			bigGlyph.replaceWith(newImg);
		}
	}

	// ── 本地导入（文件 / 文件夹 / 拖拽）──────────────────────────────────────
	//
	// 用浏览器原生 `<input type=file>` / `webkitdirectory` 选，**不借宿主对话框**：
	//   页面在 WebContentsView 里，`<input>` 直接调起系统的文件/文件夹选择器；
	//   宿主那条 `openFile` 只是"打开某个已知路径"，给不了"选一批"。
	// 上传按 3 路并发（与批量写同口径）、逐个 POST `api/import`（body ≤ 64MB，这里按 60MB 拦）。
	var IMPORT_PARALLEL = 3;
	var IMPORT_MAX_BYTES = 60 * 1024 * 1024;

	function pickerOf(kind) {
		return kind === 'folder' ? $('input[data-media-folder-input]') : $('input[data-media-file-input]');
	}

	function openPicker(kind) {
		var input = pickerOf(kind);
		if (!input) { toast('这个宿主不支持文件选择'); return; }
		input.value = '';   // 允许连续选同一个文件
		input.click();
	}

	function kindOfFile(file) {
		var mime = String(file.type || '');
		if (mime.indexOf('image/') === 0) { return 'image'; }
		if (mime.indexOf('video/') === 0) { return 'video'; }
		if (mime.indexOf('audio/') === 0) { return 'audio'; }
		if (mime.indexOf('text/') === 0 || /\.(txt|md|json)$/i.test(file.name || '')) { return 'text'; }
		return 'image';
	}

	function extOfFile(file) {
		var name = String(file.name || '');
		var dot = name.lastIndexOf('.');
		return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
	}

	/** File → base64（去掉 data URL 前缀；Host 的 import 要裸 base64）。 */
	function readAsBase64(file) {
		return new Promise(function (resolve, reject) {
			var reader = new FileReader();
			reader.onload = function () {
				var text = String(reader.result || '');
				var comma = text.indexOf(',');
				resolve(comma >= 0 ? text.slice(comma + 1) : text);
			};
			reader.onerror = function () { reject(new Error('读取文件失败')); };
			reader.readAsDataURL(file);
		});
	}

	function showUpload(text) {
		var el = $('[data-media-upload]');
		if (!el) { return; }
		el.textContent = text || '';
		el.classList.toggle('on', !!text);
	}

	/**
	 * 导入一批本地文件。
	 * @param {FileList|File[]} fileList
	 */
	function importFiles(fileList) {
		if (!state.writable) { toast('这是只读镜像，不能导入'); return Promise.resolve(); }
		var all = Array.prototype.slice.call(fileList || []);
		if (!all.length) { return Promise.resolve(); }
		var skipped = all.filter(function (f) { return f.size > IMPORT_MAX_BYTES; });
		var queue = all.filter(function (f) { return f.size <= IMPORT_MAX_BYTES; })
			// 大的先传：不然后面几个大的会让人以为卡住了
			.sort(function (a, b) { return b.size - a.size; });
		var total = queue.length;
		var done = 0;
		var failed = 0;
		var skippedNote = skipped.length ? ' · 跳过 ' + skipped.length + ' 个（>60MB）' : '';
		var paint = function () {
			showUpload('导入 ' + done + '/' + total + ' · 失败 ' + failed + skippedNote);
		};
		if (!total) {
			showUpload('全部跳过：文件都超过 60MB');
			setTimeout(function () { showUpload(''); }, 4000);
			return Promise.resolve();
		}
		paint();
		var worker = function () {
			if (!queue.length) { return Promise.resolve(); }
			var file = queue.shift();
			return readAsBase64(file).then(function (base64) {
				return postJson('import', {
					base64: base64,
					kind: kindOfFile(file),
					mime: file.type || undefined,
					ext: extOfFile(file) || undefined,
					fileName: file.name,
					// 从文件夹导入时 `webkitRelativePath` 带着子目录，用它当分组线索
					source: 'local',
				});
			}).then(function () { done++; }, function () { failed++; }).then(function () {
				paint();
				return worker();
			});
		};
		var lanes = [];
		for (var i = 0; i < Math.min(IMPORT_PARALLEL, total); i++) { lanes.push(worker()); }
		return Promise.all(lanes).then(function () {
			showUpload('导入完成 ' + done + '/' + total + (failed ? ' · 失败 ' + failed : '') + skippedNote);
			setTimeout(function () { showUpload(''); }, 4000);
			state.sel = Object.create(null);
			return reload(false).then(refreshFacets).then(refreshStats);
		});
	}

	// ── AI 助手（媒体库管家）/ 外开 ──────────────────────────────────────────
	var MEDIA_AGENT_PRESET = 'vssaros-media-librarian';

	/** 把"人正在看什么"交上去（左栏哪一格 / 筛选 / 选中项 / 命中数）—— 助手用 `media_context` 读回。 */
	function pushPageContext() {
		var selectedIds = Object.keys(state.sel).slice(0, 50);
		var payload = {
			nav: state.filter.nav || 'all',
			label: state.filter.label || '',
			kind: state.filter.kind || '',
			provider: state.filter.provider || '',
			board: state.filter.board || '',
			tag: state.filter.tag || '',
			query: state.filter.query || '',
			favorite: state.filter.favorite === true,
			untagged: state.filter.untagged === true,
			unclassified: state.filter.unclassified === true,
			deleted: state.filter.deleted === true,
			selected: selectedIds,
			selectedNames: selectedIds.map(function (id) { var v = state.byId[id]; return v ? v.name : ''; }),
			total: state.total,
		};
		// 上下文失败**不该挡**开会话（用户要的是助手，不是这个表单）
		return postJson('context', payload).catch(function () { return null; });
	}

	/**
	 * 「AI 助手」= 叫**媒体库管家**开一段会话（页面里不嵌第二份聊天：自托管页拿不到宿主的
	 * `props.conversation`，嵌了就是两套助手且没有上下文 —— 这条结论来自 studio 页的返工）。
	 *
	 * ★ 2026-10-27（交互能力）：先把手上的状态 `POST api/context` 交上去，再开会话 ⇒
	 *   用户说"就按现在这样整理"时，agent 第一步 `media_context` 就能拿到同样的范围，不用再问。
	 * 选中了某一张且它有本地文件时，顺手把文件作为引用投进输入框。
	 */
	function askAssistant() {
		var bridge = window.vssarosDsh;
		var selected = state.byId[inspId()] || null;
		// ⚠ 先交上下文再判桥：桥不在时这条路虽然开不了会话，但"用户在看什么"仍然值得记下来
		//   （比如用户在桌面窗口里看页面、去 IDE 侧叫助手，上下文照样能读到）。
		pushPageContext().then(function () {
			if (!bridge || typeof bridge.newChat !== 'function') {
				// ★ 2026-10-27（用户：「AI 助手按钮点击没反应」）：
				//   媒体库在**工作台里是 iframe** ⇒ iframe 内**没有页面桥**（preload 只注入顶层 webview）
				//   ⇒ 以前只能弹一句 toast ⇒ 看起来就是"点了没反应"。
				//   现在：把请求 **postMessage 给父窗口**（父窗口是 dsh 页面，有 IDE 桥）代开会话。
				var asked = false;
				try {
					if (window.parent && window.parent !== window) {
						window.parent.postMessage({ type: 'vssaros-media-assistant', preset: MEDIA_AGENT_PRESET }, '*');
						asked = true;
					}
				} catch (e) { asked = false; }
				toast(asked
					? '已请求在右侧打开「媒体库管家」（当前筛选已带上）'
					: '这个宿主没有页面桥：请在 agent 列表里手动选「媒体库管家」（当前筛选已记录）');
				return;
			}
			try {
				bridge.newChat(MEDIA_AGENT_PRESET);
				toast('已把当前筛选交给「媒体库管家」');
			} catch (e) {
				toast('没能打开助手：' + (e && e.message ? e.message : e));
				return;
			}
			if (selected && selected.filePath && typeof bridge.insertChatReference === 'function') {
				// 两个桥调用都是"发了就算"，失败不影响主流程
				try { bridge.insertChatReference(selected.filePath); } catch (e) { /* 忽略 */ }
			}
		});
	}

	// ── 反向同步：助手改了库 ⇒ 打开着的页面自己跟上 ─────────────────────────
	//
	// 机制：`GET api/rev` 读 SQLite 的 `total_changes()`（同连接的所有写，**含工具调用**）。
	// 页面每 2.5s 比一次，变了就 reload（保留选中）。自己的写也会让它变 ⇒ 每次自己 reload 完
	// 用 `markRev()` 把基线抬上去，避免"自己改一下、自己再刷一次"的空转。
	function fetchRev() {
		return jsonFetch(API + 'rev').then(function (body) {
			return Number(body && body.rev) || 0;
		}).catch(function () { return state.rev; });
	}

	function markRev() {
		return fetchRev().then(function (n) { state.rev = n; });
	}

	function watchRev() {
		clearInterval(state.revTimer);
		state.revTimer = setInterval(function () {
			if (document.visibilityState !== 'visible') { return; }
			fetchRev().then(function (next) {
				if (!next || next === state.rev) { return; }
				state.rev = next;
				toast('媒体库有改动（可能是助手动的），已同步');
				return reload(true).then(refreshFacets).then(refreshStats).then(markRev);
			});
		}, 2500);
	}

	/** 预取「带 token 的深链」：`window.open` 必须同步调用，否则被弹窗拦截器拦掉。 */
	var externalUrl = '';
	function prefetchExternalLink() {
		if (externalUrl || !state.writable) { return; }
		jsonFetch(API + 'link').then(function (body) {
			externalUrl = String(body.url || '');
		}).catch(function () { /* 点击时再试一次 */ });
	}

	function openExternal() {
		var btn = $('[data-media-external]');
		var open = function (url) {
			if (!url) { toast('服务端没给外开链接（宿主太旧）'); return; }
			var win = window.open(url, '_blank', 'noopener');
			if (!win) {
				// 被弹窗拦截 ⇒ 按钮变橙（与「萨罗斯工作台」同一表现），再点一次即可
				if (btn) { btn.setAttribute('data-state', 'blocked'); }
				toast('浏览器拦了弹窗：再点一次「↗ 外开」');
			} else if (btn) {
				btn.setAttribute('data-state', 'opened');
				setTimeout(function () { if (btn) { btn.removeAttribute('data-state'); } }, 1600);
			}
		};
		if (externalUrl) { open(externalUrl); return; }
		jsonFetch(API + 'link').then(function (body) {
			externalUrl = String(body.url || '');
			open(externalUrl);
		}).catch(function (e) { toast('外开失败：' + (e && e.message ? e.message : e)); });
	}

	// ── 链接文件夹（2026-10-27：显示"文件夹里的独立文件"，**不复制字节**）──────
	//
	// 为什么是"粘路径"而不是文件夹选择器：浏览器**不给** `<input webkitdirectory>` 的绝对路径
	// （`File.path` 在新版 Electron 已移除，只有 preload 的 `webUtils.getPathForFile` 能拿到，
	//  那要动宿主 preload + 桥协议）。所以这里先用内联输入，路径由 Host 侧读（同机、同用户）。
	var linkBusy = false;

	/**
	 * 打开/关闭内联输入条。`mode`：
	 *   · `link`   —— 链接文件夹（库里只记路径，看的是用户那份）
	 *   · `export` —— 导出到文件夹（把库里的字节再落一份**可读文件**；同卷硬链接）
	 * 同一个按钮再点一次 = 收起（避免"点了没反应"的错觉）。
	 */
	function openFolderBar(mode) {
		var bar = $('[data-media-linkbar]');
		if (!bar) { return; }
		var current = bar.getAttribute('data-mode') || 'link';
		if (!bar.hasAttribute('hidden') && current === mode) { bar.setAttribute('hidden', ''); return; }
		bar.setAttribute('data-mode', mode);
		var isExport = mode === 'export';
		var label = $('[data-media-linklabel]');
		if (label) { label.textContent = isExport ? '导出到文件夹' : '链接文件夹'; }
		var go = $('[data-media-linkgo]');
		if (go) { go.textContent = isExport ? '导出' : '链接'; }
		var input = $('[data-media-linkinput]');
		if (input) {
			input.placeholder = isExport
				? '导出到哪个文件夹（绝对路径），如 D:\\AI素材 —— 回车确认；同名已存在则跳过'
				: '粘贴文件夹绝对路径，如 D:\\素材\\角色（回车确认；不复制文件）';
			input.focus();
		}
		bar.removeAttribute('hidden');
	}

	function closeFolderBar() {
		var bar = $('[data-media-linkbar]');
		if (bar) { bar.setAttribute('hidden', ''); }
	}

	/** 输入条回车 / 点「确认」：按当前 mode 分派。 */
	function submitFolderBar() {
		var bar = $('[data-media-linkbar]');
		var mode = bar ? (bar.getAttribute('data-mode') || 'link') : 'link';
		if (mode === 'export') { return exportToFolder(); }
		return linkFolder();
	}

	/**
	 * 「导出到文件夹」：把**选中的**（没有选中就按当前筛选）导出成可读文件名。
	 * 与「链接」相反 —— 这是**副本**，删了导出目录不影响库；库仍以 `objects/` 为真源。
	 */
	function exportToFolder() {
		if (linkBusy) { return; }
		var input = $('[data-media-linkinput]');
		var dir = input ? String(input.value || '').trim() : '';
		if (!dir) { toast('先填一个文件夹绝对路径'); return; }
		if (!state.writable) { toast('这是只读镜像，不能导出'); return; }
		linkBusy = true;
		var ids = Object.keys(state.sel);
		var f = state.filter || {};
		var payload = { dir: dir, layout: 'provider' };
		if (ids.length) {
			payload.ids = ids;
		} else {
			// 没有选中 ⇒ 导出"当前筛选"，与页面上看到的一致（这是"所见即所得"的关键）
			payload.filter = {
				kind: f.kind || undefined,
				provider: f.provider || undefined,
				board: f.board || undefined,
				tag: f.tag || undefined,
				query: f.query || undefined,
				favorite: f.favorite === true || undefined,
				untagged: f.untagged === true || undefined,
				unclassified: f.unclassified === true || undefined,
				deleted: f.deleted === true || undefined,
			};
		}
		toast('正在导出…');
		postJson('export-folder', payload).then(function (body) {
			var skipped = body.skipped || {};
			var note = Object.keys(skipped).filter(function (k) { return skipped[k]; })
				.map(function (k) {
					return ({ noFile: '仅外链', missing: '文件不在', exists: '已存在', truncated: '超上限' })[k] + ' ' + skipped[k];
				}).join(' · ');
			toast('导出 ' + body.exported + ' 条（硬链接 ' + body.linked + ' / 复制 ' + body.copied
				+ (body.copied ? '，占用 ' + fmtBytes(body.bytes) : '，不额外占空间') + '）'
				+ (note ? ' · 跳过：' + note : '')
				+ (body.failed && body.failed.length ? ' · 失败 ' + body.failed.length : ''));
			if (body.exported > 0) { openFolderBar('export'); if (input) { input.value = ''; } }
		}).catch(function (e) {
			toast('导出失败：' + (e && e.message ? e.message : e));
		}).then(function () { linkBusy = false; });
	}

	function linkFolder() {
		if (linkBusy) { return; }
		var input = $('[data-media-linkinput]');
		var dir = input ? String(input.value || '').trim() : '';
		if (!dir) { toast('先填一个文件夹绝对路径'); return; }
		if (!state.writable) { toast('这是只读镜像，不能链接'); return; }
		linkBusy = true;
		toast('正在扫描文件夹…');
		postJson('link-folder', { dir: dir }).then(function (body) {
			var skipped = body.skipped || {};
			var skippedText = Object.keys(skipped).filter(function (k) { return skipped[k]; })
				.map(function (k) { return ({ linked: '已登记', unreadable: '读不到', unsupported: '不支持的类型', truncated: '超出上限' })[k] + ' ' + skipped[k]; })
				.join(' · ');
			toast('链接了 ' + body.added + ' 个文件' + (skippedText ? '（跳过：' + skippedText + '）' : ''));
			if (body.added > 0) { openFolderBar('link'); if (input) { input.value = ''; } }
			// 新链接的这批：左栏「来源」里会多一个 folder 分组
			return reload(false).then(refreshFacets).then(refreshStats);
		}).catch(function (e) {
			toast('链接失败：' + (e && e.message ? e.message : e));
		}).then(function () { linkBusy = false; });
	}

	// ── 卡片右键菜单（2026-10-27：用户要求「添加到 AI 窗口」）────────────────
	//
	// 为什么要自绘：页面在 `WebContentsView` 里，Electron 默认不弹原生菜单（也拿不到"当前这张"的
	// 语义）⇒ 自己做一个轻量菜单，动作都走已有的页面桥 / 已有写入函数，不新增后端能力。
	var ctxEl = null;

	function closeCtxMenu() {
		if (ctxEl) { ctxEl.remove(); ctxEl = null; }
	}

	function copyText(text, label) {
		var done = function () { toast('已复制' + label); };
		var fallback = function () {
			try {
				var ta = document.createElement('textarea');
				ta.value = text;
				ta.style.position = 'fixed';
				ta.style.opacity = '0';
				document.body.appendChild(ta);
				ta.select();
				document.execCommand('copy');
				ta.remove();
				done();
			} catch (e) { toast('复制失败：' + (e && e.message ? e.message : e)); }
		};
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text).then(done, fallback);
			return;
		}
		fallback();
	}

	function selectedViews() {
		return Object.keys(state.sel)
			.map(function (id) { return state.byId[id]; })
			.filter(Boolean);
	}

	/**
	 * 「添加到 AI 窗口」：把素材的**本地文件**作为引用投进激活的聊天草稿（宿主 `insertChatReference`）。
	 * ⚠ 只有"有本地文件"的资产能投（仅引用资产只有外链，没有可引用的路径）；
	 *   一次最多 20 条（与批量口径一致），单条失败不影响其它。
	 */
	function addToAiWindow(views) {
		var bridge = window.vssarosDsh;
		if (!bridge || typeof bridge.insertChatReference !== 'function') {
			toast('这个宿主没有页面桥：请手动把文件拖进聊天框');
			return;
		}
		var files = views.filter(function (v) { return v.filePath; });
		if (!files.length) {
			toast(views.length > 1 ? '这些素材都没有本地文件（只有外链），AI 窗口接不了' : '这条素材没有本地文件（只有外链），AI 窗口接不了');
			return;
		}
		var added = 0;
		files.slice(0, 20).forEach(function (v) {
			try { bridge.insertChatReference(v.filePath); added++; } catch (e) { /* 忽略单条 */ }
		});
		toast('已加入 ' + added + ' 条到 AI 窗口' + (files.length > 20 ? '（一次最多 20 条）' : ''));
	}

	function openCtxMenu(x, y) {
		closeCtxMenu();
		var views = selectedViews();
		if (!views.length) { return; }
		var withFile = views.filter(function (v) { return v.filePath; });
		var one = views.length === 1 ? views[0] : views[0];   // 单选动作以"第一条"为准
		var items = [
			{ act: 'ai', label: '＋ 添加到 AI 窗口', hint: withFile.length ? withFile.length + ' 条' : '无本地文件', disabled: withFile.length === 0 },
			{ sep: true },
			{ act: 'reveal', label: '在文件夹中显示', disabled: !one.filePath },
			// ★ 2026-10-27：右键也能导出（用的是**当前选中的这批**，与动作行同一个输入条）
			{ act: 'export', label: '📤 导出到…', hint: views.length + ' 条' },
			{ act: 'copyName', label: '复制文件名' },
			{ act: 'copyPath', label: '复制路径', disabled: !one.filePath },
		];
		if (state.writable) {
			items.push({ sep: true });
			items.push({ act: 'toggleDelete', label: one.deleted ? '↺ 从回收站恢复' : '⌫ 移到回收站' });
		}
		var menu = document.createElement('div');
		menu.className = 'm-ctx';
		menu.setAttribute('data-media-ctx', '');
		menu.innerHTML = items.map(function (it) {
			if (it.sep) { return '<div class="sep"></div>'; }
			return '<button type="button" data-ctx="' + it.act + '"' + (it.disabled ? ' disabled' : '') + '>'
				+ esc(it.label) + (it.hint ? '<span class="k">' + esc(it.hint) + '</span>' : '') + '</button>';
		}).join('');
		document.body.appendChild(menu);
		// 贴边修正：别让菜单跑出视口（右下角右键时最容易发生）
		var rect = menu.getBoundingClientRect();
		menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
		menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
		ctxEl = menu;
	}

	function runCtxAction(act) {
		var views = selectedViews();
		var one = views[0];
		closeCtxMenu();
		if (!one) { return; }
		if (act === 'ai') { addToAiWindow(views); return; }
		if (act === 'reveal') {
			var bridge = window.vssarosDsh;
			if (one.filePath && bridge && typeof bridge.reveal === 'function') {
				try { bridge.reveal(one.filePath); } catch (e) { toast('打开所在文件夹失败'); }
			}
			return;
		}
		if (act === 'export') { openFolderBar('export'); return; }
		if (act === 'copyName') { copyText(one.name, '文件名'); return; }
		if (act === 'copyPath') { copyText(one.filePath, '路径'); return; }
		if (act === 'toggleDelete') {
			setDeleted(one.id, !one.deleted).catch(function (e) { toast('操作失败：' + (e && e.message ? e.message : e)); });
		}
	}

	document.addEventListener('contextmenu', function (ev) {
		var card = ev.target.closest ? ev.target.closest('.m-card') : null;
		if (!card) { closeCtxMenu(); return; }
		ev.preventDefault();
		var id = card.getAttribute('data-id');
		// 右键一张没选中的卡 ⇒ 先把选中切成它（与桌面文件管理器的直觉一致）
		if (!state.sel[id]) {
			state.sel = Object.create(null);
			state.sel[id] = true;
			state.lastId = id;
			renderSelection();
			renderInspector();
			renderBatch();
		} else {
			state.lastId = id;
			renderInspector();
		}
		openCtxMenu(ev.clientX, ev.clientY);
	});
	document.addEventListener('scroll', closeCtxMenu, true);
	window.addEventListener('resize', closeCtxMenu);
	window.addEventListener('blur', closeCtxMenu);

	// ── S2 一体条（浮动胶囊）：AI 助手 + 外开 ─────────────────────────────────
	//
	// 交互照抄「萨罗斯工作台」的 `.vssWbActions`（`vssaros-workbenches/lib/client.js`）：
	//   · 右侧吸附（top:50% + translateY(-50%)），**整组可拖**；
	//   · 拖动时贴边夹紧（不出容器）；拖到左半边时标签翻到右侧（否则溢出、触发横向滚动条）；
	//   · 位置记 localStorage（下次打开还在）；
	//   · 外开被弹窗拦截时按钮变橙（`data-state="blocked"`），再点一次即可。
	var FAB_POS_KEY = 'media.fab.pos';

	function fabEl() { return $('[data-media-fab]'); }

	function clampFab(el, host, pos) {
		var hr = host.getBoundingClientRect();
		var br = el.getBoundingClientRect();
		var maxL = Math.max(0, hr.width - br.width);
		var maxT = Math.max(0, hr.height - br.height);
		return {
			x: Math.round(Math.min(Math.max(0, pos.x), maxL)),
			y: Math.round(Math.min(Math.max(8, pos.y), maxT)),
		};
	}

	function applyFabPos(el, host, pos) {
		el.__vssPos = pos || null;
		if (!pos) {
			el.style.left = ''; el.style.top = '';
			el.style.right = '12px'; el.style.transform = 'translateY(-50%)';
			el.removeAttribute('data-moved');
			el.removeAttribute('data-label');
			return;
		}
		el.style.left = pos.x + 'px';
		el.style.top = pos.y + 'px';
		el.style.right = 'auto';
		el.style.transform = 'none';
		el.setAttribute('data-moved', '');
		// 标签翻转：整组在容器左半边 ⇒ 标签朝右（否则会溢出容器）
		var hr = host.getBoundingClientRect();
		var br = el.getBoundingClientRect();
		el.setAttribute('data-label', (pos.x + br.width / 2) < hr.width / 2 ? 'right' : 'left');
	}

	function attachFabDrag(el, host) {
		// ★ 2026-10-27（按钮改成实心文字胶囊后，整块都是按钮 ⇒ 拖拽把手也只能是按钮）：
		//   按下后移动 > 3px 才算拖；真拖了就把随后的那次 click 吃掉（否则会误触发"叫助手"）。
		el.addEventListener('click', function (ev) {
			if (el.__vssDragged) { ev.stopPropagation(); ev.preventDefault(); el.__vssDragged = false; }
		}, true);
		el.addEventListener('pointerdown', function (ev) {
			if (ev.button !== 0) { return; }
			ev.preventDefault();
			var hr = host.getBoundingClientRect();
			var br = el.getBoundingClientRect();
			var origin = el.__vssPos || { x: br.left - hr.left, y: br.top - hr.top };
			var startX = ev.clientX, startY = ev.clientY;
			var moved = false;
			el.setAttribute('data-dragging', '');
			var onMove = function (e) {
				var dx = e.clientX - startX, dy = e.clientY - startY;
				if (!moved && Math.abs(dx) + Math.abs(dy) < 3) { return; }
				moved = true;
				applyFabPos(el, host, clampFab(el, host, { x: origin.x + dx, y: origin.y + dy }));
			};
			var onUp = function () {
				el.removeAttribute('data-dragging');
				document.removeEventListener('pointermove', onMove);
				document.removeEventListener('pointerup', onUp);
				if (moved) {
					el.__vssDragged = true;   // 这次是拖 ⇒ 吃掉随后的 click
					// ⚠ 浏览器在"拖完仍停在按钮上"时**也会**发 click ⇒ 上面的捕获会吃掉它；
					//   但若那次 click 压根没来（例如指针移开了），标记会残留 ⇒ 下一次正常点击被误吃。
					//   ⇒ 兜一个超时清掉。
					setTimeout(function () { el.__vssDragged = false; }, 400);
					if (el.__vssPos) {
						try { localStorage.setItem(FAB_POS_KEY, JSON.stringify(el.__vssPos)); } catch (e) { /* 忽略 */ }
					}
				}
			};
			document.addEventListener('pointermove', onMove);
			document.addEventListener('pointerup', onUp);
		});
	}

	function initFab() {
		var el = fabEl();
		if (!el) { return; }
		var host = el.parentElement;
		if (!host) { return; }
		attachFabDrag(el, host);
		try {
			var saved = JSON.parse(localStorage.getItem(FAB_POS_KEY) || 'null');
			if (saved && typeof saved.x === 'number') { applyFabPos(el, host, clampFab(el, host, saved)); }
		} catch (e) { /* 忽略 */ }
	}

	// ── 与「萨罗斯工作台」外壳的 AI 助手栏契约（2026-10-27）────────────────────
	//
	// 现象：媒体库被 dashboard 目录收进工作台后，外壳（S2 一体条）会渲染「« 展开 AI 助手」，
	//   点它 ⇒ 外壳派发 `vssaros:assist-expand` ⇒ **页面没监听 ⇒ 毫无反应**（用户报的现象）。
	// 契约（见 `dsh-plugins/check-assistant-collapse.mjs` 第 ④ 条）：
	//   页面侧只写一个属性（`data-vssaros-assist-collapsed`）+ 监听这两个事件，不自己造按钮。
	// 媒体库**没有页内助手栏**（自托管页拿不到宿主的 props.conversation，嵌了就是两套助手）⇒
	//   「展开」翻译成「叫媒体库管家」（桥 newChat ⇒ IDE 侧开聊天页签），状态写回属性让按钮换面孔。
	function setAssistCollapsed(collapsed) {
		var root = $('[data-vssaros-media-app]');
		if (root) { root.setAttribute('data-vssaros-assist-collapsed', collapsed ? '1' : '0'); }
		// ★ 2026-10-27（用户定稿「方案 A」后统一文案）：标签文字与「萨罗斯工作台」**完全一致**
		//   —— 折叠时「展开 AI 助手」、展开后「收起 AI 助手」（工作台那边也是这两个词）。
		//   注意：媒体库**没有页内助手栏** ⇒ 这里的「展开」= 叫「媒体库管家」开会话（IDE 侧），
		//   「收起」则如实告诉用户去 IDE 那边收（会话不在本页）。
		var btn = $('[data-media-assistant]');
		var wrap = btn && btn.parentElement;
		var lab = wrap && wrap.querySelector('.m-fabLabel');
		var text = collapsed ? '展开 AI 助手' : '收起 AI 助手';
		if (lab) { lab.textContent = text; }
		if (btn) {
			btn.setAttribute('title', text + '：叫「媒体库管家」来帮你找素材 / 整理素材');
		}
	}

	/** 胶囊上的 ✦ 按钮：**按当前状态**展开/收起（与工作台的 «/» 按钮同一套语义）。 */
	function toggleAssistant() {
		var root = $('[data-vssaros-media-app]');
		var collapsed = !root || root.getAttribute('data-vssaros-assist-collapsed') !== '0';
		if (collapsed) {
			setAssistCollapsed(false);
			askAssistant();
		} else {
			setAssistCollapsed(true);
			toast('助手会话在 IDE 侧打开着，收起请在那边操作');
		}
	}
	window.addEventListener('vssaros:assist-expand', function () {
		setAssistCollapsed(false);
		askAssistant();
	});
	window.addEventListener('vssaros:assist-collapse', function () {
		setAssistCollapsed(true);
		toast('助手会话在 IDE 侧打开着，收起请在那边操作');
	});

	// ── 事件接线 ────────────────────────────────────────────────────────────
	document.addEventListener('click', function (ev) {
		var target = ev.target;

		// 右键菜单：**先**处理菜单项，再关菜单（顺序反了会把自己的点击吞掉）
		var ctxBtn = target.closest ? target.closest('[data-ctx]') : null;
		if (ctxBtn) { runCtxAction(ctxBtn.getAttribute('data-ctx')); return; }
		if (ctxEl) { closeCtxMenu(); }

		var nav = target.closest('[data-nav]');
		if (nav) { applyNav(nav.getAttribute('data-nav'), nav.querySelector('.lb') ? nav.querySelector('.lb').textContent : ''); return; }

		// 本地导入 / AI 助手 / 外开（2026-10-26）
		var importBtn = target.closest('[data-media-import]');
		if (importBtn) { openPicker(importBtn.getAttribute('data-media-import')); return; }
		// 链接文件夹（不复制字节）与导出到文件夹（落可读副本）：共用一条内联输入
		if (target.closest('[data-media-link-folder]')) { openFolderBar('link'); return; }
		if (target.closest('[data-media-export-folder]')) { openFolderBar('export'); return; }
		if (target.closest('[data-media-linkgo]')) { submitFolderBar(); return; }
		if (target.closest('[data-media-linkcancel]')) { closeFolderBar(); return; }
		if (target.closest('[data-media-assistant]')) { toggleAssistant(); return; }
		if (target.closest('[data-media-external]')) { openExternal(); return; }

		var chipKind = target.closest('[data-kind].m-chip');
		if (chipKind) { state.filter.kind = chipKind.getAttribute('data-kind') || ''; reload(false); return; }
		var chipProvider = target.closest('[data-provider]');
		if (chipProvider) { state.filter.provider = chipProvider.getAttribute('data-provider') || ''; reload(false); return; }
		if (target.closest('[data-fav]')) { state.filter.favorite = !state.filter.favorite; reload(false); return; }

		var mode = target.closest('[data-media-view] button');
		if (mode) {
			state.mode = mode.getAttribute('data-mode') || 'grid';
			$$('[data-media-view] button').forEach(function (b) { b.classList.toggle('on', b === mode); });
			renderList();
			return;
		}
		if (target.closest('[data-media-insp-toggle]')) {
			var insp = $('[data-vssaros-media-insp]');
			if (insp) { insp.classList.toggle('hide'); }
			return;
		}
		if (target.closest('[data-media-side-toggle]')) {
			var side = $('[data-vssaros-media-side]');
			if (side) { side.classList.toggle('show'); }
			return;
		}
		if (target.closest('[data-media-more]')) { loadMore(); return; }

		var card = target.closest('.m-card');
		if (card) {
			var id = card.getAttribute('data-id');
			if (ev.ctrlKey || ev.metaKey) {
				if (state.sel[id]) { delete state.sel[id]; } else { state.sel[id] = true; }
			} else if (ev.shiftKey && state.lastId) {
				var ids = state.views.map(function (v) { return v.id; });
				var from = ids.indexOf(state.lastId);
				var to = ids.indexOf(id);
				if (from >= 0 && to >= 0) {
					ids.slice(Math.min(from, to), Math.max(from, to) + 1).forEach(function (x) { state.sel[x] = true; });
				}
			} else {
				state.sel = Object.create(null);
				state.sel[id] = true;
			}
			state.lastId = id;
			// ★ 只改选中态与右侧检查器：重建整张列表会把 60 张卡连同图片一起重挂（真机卡顿来源之一）
			renderSelection();
			renderInspector();
			renderBatch();
			return;
		}

		var batch = target.closest('[data-batch]');
		if (batch) {
			var op = batch.getAttribute('data-batch');
			var selected = Object.keys(state.sel);
			if (!selected.length) { toast('先选几张'); return; }
			if (!state.writable) { toast('这是只读镜像，不能写'); return; }
			if (op === 'favorite') { runBatch(selected, function (x) { return postJson('favorite', { id: x, value: true }); }, '收藏'); }
			if (op === 'unfavorite') { runBatch(selected, function (x) { return postJson('favorite', { id: x, value: false }); }, '取消收藏'); }
			if (op === 'delete') { runBatch(selected, function (x) { return postJson('delete', { id: x }); }, '移入回收站'); }
			if (op === 'restore') { runBatch(selected, function (x) { return postJson('restore', { id: x }); }, '恢复'); }
			Promise.resolve(refreshFacets()).then(refreshStats);
			return;
		}
		if (target.closest('[data-media-batch-clear]')) { state.sel = Object.create(null); renderSelection(); renderBatch(); return; }

		var act = target.closest('[data-act]');
		if (act) {
			var what = act.getAttribute('data-act');
			var vid = inspId();
			if (!vid) { toast('没有可操作的素材'); return; }
			if (!state.writable) { toast('这是只读镜像，不能写'); return; }
			if (what === 'fav') {
				var current = state.byId[vid] ? state.byId[vid].favorite : false;
				setFavorite(vid, !current).catch(function (e) { toast('收藏失败：' + e.message); });
			}
			if (what === 'delete') { setDeleted(vid, true).catch(function (e) { toast('删除失败：' + e.message); }); }
			if (what === 'restore') { setDeleted(vid, false).catch(function (e) { toast('恢复失败：' + e.message); }); }
			if (what === 'purge') {
				// 物理删除：行 + 文件（内容寻址去重由 Host 判断），不可恢复 ⇒ 两步确认
				armConfirm(act, '确认永久删除？', function () {
					return postJson('purge', { id: vid }).then(function (body) {
						state.lastId = null;
						state.inspId = null;
						delete state.byId[vid];
						toast('已永久删除' + (body.removedFile ? '（含文件，释放 ' + fmtBytes(body.freedBytes) + '）' : '（文件仍被其它条目引用，未删）'));
						return reload(true).then(refreshFacets).then(refreshStats);
					}).catch(function (e) { toast('永久删除失败：' + e.message); });
				});
			}
			return;
		}

		// 「清空回收站」（只在回收站视图出现）
		var purgeDeletedBtn = target.closest('[data-media-purge-deleted]');
		if (purgeDeletedBtn) {
			if (!state.writable) { toast('这是只读镜像，不能写'); return; }
			var deletedCount = (state.facets && state.facets.deleted) || 0;
			if (!deletedCount) { toast('回收站是空的'); return; }
			armConfirm(purgeDeletedBtn, '确认永久删除 ' + deletedCount + ' 条？', function () {
				return postJson('purge-deleted', {}).then(function (body) {
					toast('已永久删除 ' + body.count + ' 条 · 释放 ' + fmtBytes(body.freedBytes)
						+ (body.failed && body.failed.length ? ' · 失败 ' + body.failed.length : ''));
					state.sel = Object.create(null);
					return reload(false).then(refreshFacets).then(refreshStats);
				}).catch(function (e) { toast('清空回收站失败：' + e.message); });
			});
			return;
		}

		// 「清理孤儿文件」
		var cleanBtn = target.closest('[data-media-clean-orphans]');
		if (cleanBtn) {
			if (!state.writable) { toast('这是只读镜像，不能写'); return; }
			armConfirm(cleanBtn, '确认清理？', function () {
				return postJson('clean-orphans', {}).then(function (body) {
					toast('清掉 ' + body.removedObjects + ' 个对象文件 / ' + body.removedThumbs + ' 张缩略图 · 释放 ' + fmtBytes(body.freedBytes));
				}).catch(function (e) { toast('清理失败：' + e.message); });
			});
			return;
		}

		var tagDel = target.closest('[data-tag-del]');
		if (tagDel) {
			var idForTag = inspId();
			if (!idForTag) { return; }
			var v = state.byId[idForTag];
			var rest = (v ? v.tags : []).filter(function (t) { return t !== tagDel.getAttribute('data-tag-del'); });
			setTags(idForTag, rest).catch(function (e) { toast('移除标签失败：' + e.message); });
			return;
		}
		if (target.closest('[data-insp-tagadd]')) { addTagFromInput(); return; }
	});

	function addTagFromInput() {
		var input = $('[data-insp-taginput]');
		var id = inspId();
		if (!input || !id) { return; }
		var text = String(input.value || '').trim().replace(/^#/, '');
		if (!text) { return; }
		var v = state.byId[id];
		var next = (v ? v.tags.slice() : []);
		if (next.indexOf(text) < 0) { next.push(text); }
		input.value = '';
		setTags(id, next).catch(function (e) { toast('加标签失败：' + e.message); });
	}

	document.addEventListener('change', function (ev) {
		var board = ev.target.closest('[data-insp-board]');
		if (board) { applyBoardInput(board); }
		// 本地导入：文件 / 文件夹选择器
		if (ev.target.matches('[data-media-file-input],[data-media-folder-input]')) {
			var files = ev.target.files;
			if (files && files.length) { importFiles(files); }
		}
	});

	// 拖文件进页面 = 导入（拖到左栏分组上那条语义仍在下面，这里只接"文件"）
	document.addEventListener('dragover', function (ev) {
		var dt = ev.dataTransfer;
		if (!dt || !dt.types || Array.prototype.indexOf.call(dt.types, 'Files') < 0) { return; }
		if (!state.writable) { return; }
		ev.preventDefault();
		dt.dropEffect = 'copy';
		var list = $('[data-vssaros-media-list]');
		if (list) { list.classList.add('drop-target'); }
	});
	document.addEventListener('dragleave', function (ev) {
		if (ev.target && ev.target.matches && ev.target.matches('[data-vssaros-media-list]')) {
			ev.target.classList.remove('drop-target');
		}
	});
	document.addEventListener('drop', function (ev) {
		var dt = ev.dataTransfer;
		if (!dt || !dt.files || !dt.files.length) { return; }
		ev.preventDefault();
		var list = $('[data-vssaros-media-list]');
		if (list) { list.classList.remove('drop-target'); }
		importFiles(dt.files);
	});

	/**
	 * 两步确认（破坏性操作）：第一次点只把按钮变成"确认…"，4 秒内再点才真执行。
	 * 为什么不用 `window.confirm`：页面跑在 WebContentsView 里，原生模态对话框在部分宿主上会被拦，
	 * 而"点了没反应"最难排查 ⇒ 自带两段式，状态在 DOM 上可见。
	 */
	var armedButton = null;
	function disarm(btn) {
		if (!btn) { return; }
		clearTimeout(btn._armTimer);
		if (btn.getAttribute('data-label')) { btn.textContent = btn.getAttribute('data-label'); }
		btn.classList.remove('armed');
	}
	function armConfirm(btn, armedText, run) {
		if (armedButton === btn) {
			disarm(btn);
			armedButton = null;
			return run();
		}
		if (armedButton) { disarm(armedButton); }
		armedButton = btn;
		btn.setAttribute('data-label', btn.textContent);
		btn.textContent = armedText;
		btn.classList.add('armed');
		btn._armTimer = setTimeout(function () {
			if (armedButton === btn) { armedButton = null; }
			disarm(btn);
		}, 4000);
		return undefined;
	}

	var noteTimer = 0;
	document.addEventListener('input', function (ev) {
		if (ev.target.matches('[data-media-density]')) {
			var list = $('[data-vssaros-media-list]');
			if (list) { list.style.setProperty('--thumb', ev.target.value + 'px'); }
			return;
		}
		var search = ev.target.closest('[data-media-search]');
		if (search) {
			clearTimeout(search._t);
			var value = search.value;
			search._t = setTimeout(function () {
				state.filter.query = String(value || '').trim();
				state.filter.label = state.filter.label || '全部';
				reload(false);
			}, 220);
			return;
		}
		var note = ev.target.closest('[data-insp-note]');
		if (note) {
			var noteId = inspId();
			if (!noteId) { return; }
			clearTimeout(noteTimer);
			var text = note.value;
			var id = noteId;
			noteTimer = setTimeout(function () {
				setNote(id, text).catch(function (e) { toast('保存注释失败：' + e.message); });
			}, 500);
		}
	});

	document.addEventListener('keydown', function (ev) {
		if (ev.key === 'Enter' && ev.target.matches('[data-insp-taginput]')) { ev.preventDefault(); addTagFromInput(); return; }
		// 分组输入框：回车 ⇒ 失焦 ⇒ 触发 change ⇒ 应用（新建分组同理）
		// 分组输入框：回车 ⇒ 直接应用（新建分组同理）；不等 blur
		if (ev.key === 'Enter' && ev.target.matches('[data-insp-board]')) { ev.preventDefault(); applyBoardInput(ev.target); return; }
		if (ev.key === 'Enter' && ev.target.matches('[data-media-linkinput]')) { ev.preventDefault(); submitFolderBar(); return; }
		if (ev.key === 'Escape' && ev.target.matches('[data-media-linkinput]')) { ev.stopPropagation(); closeFolderBar(); return; }
		if (ev.key === 'Escape') { closeCtxMenu(); state.sel = Object.create(null); renderSelection(); renderBatch(); return; }
		if (ev.key === '/' && !/input|textarea|select/i.test(ev.target.tagName)) {
			var search = $('[data-media-search]');
			if (search) { ev.preventDefault(); search.focus(); }
		}
	});

	// 拖到左栏分组 = 改 board（Eagle 的核心动作）
	document.addEventListener('dragstart', function (ev) {
		var card = ev.target.closest('.m-card');
		if (!card) { return; }
		try { ev.dataTransfer.setData('text/plain', card.getAttribute('data-id')); } catch (e) { /* 忽略 */ }
	});
	document.addEventListener('dragover', function (ev) {
		var nav = ev.target.closest('[data-nav^="board:"]');
		if (!nav || !state.writable) { return; }
		ev.preventDefault();
		nav.classList.add('drop');
	});
	document.addEventListener('dragleave', function (ev) {
		var nav = ev.target.closest('[data-nav^="board:"]');
		if (nav) { nav.classList.remove('drop'); }
	});
	document.addEventListener('drop', function (ev) {
		var nav = ev.target.closest('[data-nav^="board:"]');
		if (!nav) { return; }
		nav.classList.remove('drop');
		if (!state.writable) { return; }
		ev.preventDefault();
		var id = '';
		try { id = ev.dataTransfer.getData('text/plain'); } catch (e) { id = ''; }
		if (!id) { return; }
		var board = nav.getAttribute('data-nav').slice(6);
		setBoard(id, board).catch(function (e) { toast('移动分组失败：' + e.message); });
	});

	// 窄容器（IDE 中栏 / 侧栏）默认把检查器收起来 —— 否则它一上来就盖住半边列表
	// ★ 2026-10-28（用户：「缺少右侧编辑区」）：阈值跟着 CSS 一起降到 560。
	//   工作台面板通常 700~900px，以前这里会**自动藏掉检查器** ⇒ 右侧编辑区"消失"。
	if (window.innerWidth <= 560) {
		var narrowInsp = $('[data-vssaros-media-insp]');
		if (narrowInsp) { narrowInsp.classList.add('hide'); }
	}

	// 首屏：补 facets/stats（SSR 已有，这里只保证"服务端算的"和"客户端算的"一致）。
	// ⚠ 别再 `renderAll()`：首屏卡片是 SSR 出来的，重建一遍等于白白重挂 60 张图（真机切页签卡顿）。
	refreshFacets().then(function () {
		renderSide();
		renderChips();
		renderInspector();
	});
	observePreviews();
	// 「外开」的深链提前要（点击时必须同步 window.open，否则被弹窗拦截）
	prefetchExternalLink();
	// S2 一体条：浮动胶囊的拖拽与位置恢复
	// ★ 2026-10-28（用户：「移除红框内多余的浮动工具栏」）：
	//   媒体库被工作台收进面板时是 **iframe**，而外壳（vssaros-workbenches）**已经渲染了自己那条胶囊**
	//   （.vssWbActions，位置/尺寸/样式与这条几乎完全重合）⇒ 两条叠在一起 ⇒ 看起来就是"多余的工具栏"。
	//   规则：**被嵌在 iframe 里 ⇒ 页面不自带浮动条**（用外壳那条）；只有独立打开（顶层窗口）才自带。
	if (window.self !== window.top) {
		var ownFab = $('[data-media-fab]');
		if (ownFab && ownFab.parentNode) { ownFab.parentNode.removeChild(ownFab); }
	} else {
		initFab();
	}
	// 反向同步：先抬基线，再开始比（顺序反了会把"当前状态"当成一次改动，白刷一遍）
	markRev().then(watchRev);
})();
