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
		mode: 'grid',
		offset: 0,
		limit: boot.limit || 60,
		total: boot.total || 0,
		filter: boot.filter || { nav: 'all', kind: '', provider: '', favorite: false, untagged: false, unclassified: false, deleted: false, query: '' },
		// 预览生成（图片缩略图 / 视频海报）：只在**可见**卡片上做，串行一条
		previewActive: 0,
		previewQueue: [],
		previewFailed: Object.create(null),
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

	function boardOptions(v) {
		var boards = (state.facets && state.facets.boards ? state.facets.boards : []).map(function (b) { return b.name; });
		if (v.board && boards.indexOf(v.board) < 0) { boards.push(v.board); }
		return ['<option value="">（未分组）</option>'].concat(boards.map(function (b) {
			return '<option value="' + esc(b) + '"' + (b === v.board ? ' selected' : '') + '>' + esc(b) + '</option>';
		})).join('');
	}

	function renderInspector() {
		var host = $('[data-vssaros-media-insp]');
		if (!host) { return; }
		var v = state.lastId ? state.byId[state.lastId] : state.views[0];
		if (!v) { host.innerHTML = '<div class="m-empty">未选中资产</div>'; return; }
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
			+ '<div class="m-blk"><div class="m-bh">分组</div><select class="m-input" name="board" data-insp-board' + ro + '>'
			+ boardOptions(v) + '</select></div>'
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

	/**
	 * 「AI 助手」= 叫**媒体库管家**开一段会话（页面里不嵌第二份聊天：自托管页拿不到宿主的
	 * `props.conversation`，嵌了就是两套助手且没有上下文 —— 这条结论来自 studio 页的返工）。
	 * 选中了某张素材且它有本地文件时，顺手把文件作为引用投进输入框。
	 */
	function askAssistant() {
		var bridge = window.vssarosDsh;
		if (!bridge || typeof bridge.newChat !== 'function') {
			toast('这个宿主没有页面桥：请在 agent 列表里手动选「媒体库管家」');
			return;
		}
		var selected = state.lastId ? state.byId[state.lastId] : null;
		try {
			bridge.newChat(MEDIA_AGENT_PRESET);
		} catch (e) {
			toast('没能打开助手：' + (e && e.message ? e.message : e));
			return;
		}
		if (selected && selected.filePath && typeof bridge.insertChatReference === 'function') {
			// 两个桥调用都是"发了就算"，失败不影响主流程
			try { bridge.insertChatReference(selected.filePath); } catch (e) { /* 忽略 */ }
		}
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
		var open = function (url) {
			if (!url) { toast('服务端没给外开链接（宿主太旧）'); return; }
			var win = window.open(url, '_blank', 'noopener');
			if (!win) { toast('浏览器拦了弹窗：再点一次「↗ 外开」'); }
		};
		if (externalUrl) { open(externalUrl); return; }
		jsonFetch(API + 'link').then(function (body) {
			externalUrl = String(body.url || '');
			open(externalUrl);
		}).catch(function (e) { toast('外开失败：' + (e && e.message ? e.message : e)); });
	}

	// ── 事件接线 ────────────────────────────────────────────────────────────
	document.addEventListener('click', function (ev) {
		var target = ev.target;

		var nav = target.closest('[data-nav]');
		if (nav) { applyNav(nav.getAttribute('data-nav'), nav.querySelector('.lb') ? nav.querySelector('.lb').textContent : ''); return; }

		// 本地导入 / AI 助手 / 外开（2026-10-26）
		var importBtn = target.closest('[data-media-import]');
		if (importBtn) { openPicker(importBtn.getAttribute('data-media-import')); return; }
		if (target.closest('[data-media-assistant]')) { askAssistant(); return; }
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
		if (act && state.lastId) {
			var what = act.getAttribute('data-act');
			var vid = state.lastId;
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
		if (tagDel && state.lastId) {
			var idForTag = state.lastId;
			var v = state.byId[idForTag];
			var rest = (v ? v.tags : []).filter(function (t) { return t !== tagDel.getAttribute('data-tag-del'); });
			setTags(idForTag, rest).catch(function (e) { toast('移除标签失败：' + e.message); });
			return;
		}
		if (target.closest('[data-insp-tagadd]')) { addTagFromInput(); return; }
	});

	function addTagFromInput() {
		var input = $('[data-insp-taginput]');
		if (!input || !state.lastId) { return; }
		var text = String(input.value || '').trim().replace(/^#/, '');
		if (!text) { return; }
		var v = state.byId[state.lastId];
		var next = (v ? v.tags.slice() : []);
		if (next.indexOf(text) < 0) { next.push(text); }
		input.value = '';
		setTags(state.lastId, next).catch(function (e) { toast('加标签失败：' + e.message); });
	}

	document.addEventListener('change', function (ev) {
		var board = ev.target.closest('[data-insp-board]');
		if (board && state.lastId) {
			setBoard(state.lastId, board.value).catch(function (e) { toast('移动分组失败：' + e.message); });
		}
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
		if (note && state.lastId) {
			clearTimeout(noteTimer);
			var text = note.value;
			var id = state.lastId;
			noteTimer = setTimeout(function () {
				setNote(id, text).catch(function (e) { toast('保存注释失败：' + e.message); });
			}, 500);
		}
	});

	document.addEventListener('keydown', function (ev) {
		if (ev.key === 'Enter' && ev.target.matches('[data-insp-taginput]')) { ev.preventDefault(); addTagFromInput(); return; }
		if (ev.key === 'Escape') { state.sel = Object.create(null); renderSelection(); renderBatch(); return; }
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
	if (window.innerWidth <= 820) {
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
})();
