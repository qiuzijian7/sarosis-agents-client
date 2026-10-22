// @vssaros/dsh-marketplace — 商城工作台的前端（2026-10-22）。
//
// ★ 为什么是**自托管页面**而不是 dsh 客户端的 React chunk：
//   本页走 `vssaros.view = { kind:'page', route:'/x/marketplace/' }` ⇒ IDE 直接开这个 URL ⇒
//   页面自带 HTML + JS（原生 DOM，无 React 依赖）✓ ⇒ 不进 dsh 的 chunk 装载器 ✓。
//
// ★ 纪律：
//   1. **权限只按服务端下发的 `permissions` 渲染**，前端不自行判断 admin/作者 ✓；
//   2. **失败如实显示**（后端回 ok:false 就显示错误，不假装成功）✓；
//   3. 所有动作都经 `/x/marketplace/api/action` 转发给 IDE（认证/下载/刷新都在那边）✓。
//
// ★ 页面脚本里的事件用 `addEventListener` 绑定（不用内联 onclick）⇒ 不必把函数挂 window ✓。

(function () {
	'use strict';

	/** 商城动作统一入口（转发给 IDE ⇒ 认证与副作用都在 IDE 侧 ✓）。 */
	async function action(op, params) {
		let res;
		try {
			res = await fetch('/x/marketplace/api/action', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op, params: params || {} }),
				credentials: 'same-origin',
				cache: 'no-store',
			});
		} catch (e) {
			return { ok: false, error: '连不上商城通道：' + String(e && e.message ? e.message : e) };
		}
		let data = null;
		try { data = await res.json(); } catch { data = null; }
		if (!data) { return { ok: false, error: '商城通道没有回执（HTTP ' + res.status + '）' }; }
		return data;
	}

	/** 商品类型的中文名（与服务端 kinds 同口径）。 */
	const KIND_LABEL = {
		agent: 'Agent', skill: 'Skill', mcp: 'MCP',
		knowledge: '知识库', workflow: '工作流', workbench: '工作台',
	};
	/** 页签只展示这几类（mcp/knowledge 暂不进页签，但接口支持 ✓）。 */
	const TABS = [
		{ id: '', label: '全部' },
		{ id: 'agent', label: 'Agent' },
		{ id: 'skill', label: 'Skill' },
		{ id: 'workbench', label: '工作台' },
		{ id: 'workflow', label: '工作流' },
	];

	/** 页面状态。 */
	const state = {
		tab: 'market',        // market | mine | installed | admin
		kind: '',             // 当前分类
		q: '',
		items: [],
		total: 0,
		detail: null,
		busy: false,
		msg: null,            // { text, kind }
		/** 发布表单（null = 关闭）；{ items, pick, version, changelog, busy, error } */
		publish: null,
		/** 当前页码（"加载更多"靠它 +1；0/1 都当第一页 ✓） */
		page: 1,
		/** 编辑表单（null = 关闭）；{ slug, name, description, category, icon, visibility, busy, error } */
		edit: null,
		/** 排序：recent（默认）/popular/name —— 服务端原生支持，零额外接口 ✓ */
		sort: 'recent',
		/** 当前分类（'' = 全部） */
		category: '',
		/**
		 * 已知分类（从已加载列表**累积提取**；切 kind 时清空 —— 不同类型的分类不同）。
		 * 用累积而不是"当前页覆盖"：否则加载更多后下拉项会跳变 ✓
		 */
		categories: [],
	};

	const root = document.getElementById('vs-mp-root');
	if (!root) { return; }

	/** 顶部消息条。 */
	function showMsg(text, kind) {
		state.msg = { text: String(text || ''), kind: kind || 'info' };
		render();
	}

	/** 每页条数（商城里单类 500+ 条 ⇒ 必须分页 ✓）。 */
	const PAGE_SIZE = 60;

	/**
	 * 拉清单。
	 *
	 * @param {{ append?: boolean }} [opts] `append` = 只追加下一页（"加载更多"），否则从第 1 页重来
	 */
	async function load(opts) {
		const append = Boolean(opts && opts.append);
		state.busy = true;
		if (!append) { state.page = 1; }
		render();
		const page = append ? (state.page || 1) + 1 : 1;
		const params = { limit: PAGE_SIZE, page: page };
		if (state.kind) { params.kind = state.kind; }
		if (state.q) { params.q = state.q; }
		if (state.sort) { params.sort = state.sort; }
		// 分类筛选（服务端原生支持 `category`；分类清单由已加载列表**累积提取** ✓
		//   —— 省掉一个后端接口：商城的分类是运营维度，从首页数据里就能看出来）
		if (state.category) { params.category = state.category; }
		if (state.tab === 'mine') { params.scope = 'mine'; }
		// ★ 「管理」页签走**审核队列**（服务端 /admin/review，requireAdmin 判权）——
		//   非管理员会拿到 403，如实显示"需要管理员权限"（不静默空列表）✓
		let op = 'list';
		if (state.tab === 'installed') { op = 'installed'; }
		if (state.tab === 'admin') { op = 'reviewList'; }
		const res = await action(op, params);
		state.busy = false;
		if (!res || res.ok === false) {
			if (!append) { state.items = []; state.total = 0; }
			showMsg((res && res.error) || '商城清单取不到', 'error');
			return;
		}
		const got = Array.isArray(res.items) ? res.items : [];
		// 审核队列 / 已安装台账一次给全 ⇒ 不参与分页累积
		const paginated = op === 'list';
		state.items = append && paginated ? state.items.concat(got) : got;
		state.total = Number(res.total) || state.items.length;
		state.page = append ? page : 1;
		// 累积分类（只看列表页；审核/已安装没有分类的概念）
		if (paginated) {
			const known = new Set(state.categories);
			for (const it of state.items) {
				const c = String(it.category || '').trim();
				if (c) { known.add(c); }
			}
			state.categories = [...known].sort();
		}
		render();
	}

	/** 打开详情。 */
	async function openDetail(slug) {
		const res = await action('detail', { slug });
		if (!res || res.ok === false) {
			showMsg((res && res.error) || '详情取不到', 'error');
			return;
		}
		state.detail = res;
		render();
	}

	/** 执行一个动作（安装/卸载/升级/发布/下架）。 */
	async function run(op, params, okText) {
		state.busy = true;
		render();
		const res = await action(op, params);
		state.busy = false;
		if (!res || res.ok === false) {
			showMsg((res && res.error) || '操作失败', 'error');
			return;
		}
		showMsg(okText || '完成', 'ok');
		await load();
		if (state.detail && state.detail.slug === params.slug) {
			await openDetail(params.slug);
		}
	}

	// ── 渲染 ──────────────────────────────────────────────
	function esc(s) {
		return String(s == null ? '' : s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	/** 顶部四个页签。 */
	function renderTabs() {
		const items = [
			{ id: 'market', label: '商城' },
			{ id: 'mine', label: '我的发布' },
			{ id: 'installed', label: '已安装' },
			{ id: 'admin', label: '管理' },
		];
		return items.map(it => (
			'<button class="vs-mp-tab' + (state.tab === it.id ? ' active' : '') + '" data-tab="' + it.id + '">' + esc(it.label) + '</button>'
		)).join('');
	}

	/** 分类子页签。 */
	function renderKindTabs() {
		if (state.tab === 'admin') { return ''; }
		return TABS.map(t => (
			'<button class="vs-mp-kind' + (state.kind === t.id ? ' active' : '') + '" data-kind="' + t.id + '">' + esc(t.label) + '</button>'
		)).join('');
	}

	/**
	 * 分类筛选（运营维度：宣发/美术/文档…）。
	 *
	 * 分类清单来自已加载列表的**累积提取** ⇒ 不需要后端额外接口 ✓
	 * 只有 ≥2 个分类时才显示（只有一个分类时它是噪音 ✗）
	 */
	function renderCategoryChips() {
		if (state.tab === 'admin' || state.tab === 'installed' || state.tab === 'mine') { return ''; }
		if (state.categories.length < 2 && !state.category) { return ''; }
		const chips = [''].concat(state.categories).map(c => (
			'<button class="vs-mp-kind' + (state.category === c ? ' active' : '') + '" data-category="' + esc(c) + '">' +
			esc(c || '全部分类') + '</button>'
		)).join('');
		return '<nav class="vs-mp-kinds vs-mp-cats">' + chips + '</nav>';
	}

	/** 一张卡片。 */
	function renderCard(pkg) {
		const perm = pkg.permissions || {};
		const version = pkg.version ? 'v' + pkg.version : '';
		const statusTag = pkg.status && pkg.status !== 'active'
			? '<span class="vs-mp-tag warn">' + esc(pkg.status === 'pending_review' ? '待审核' : pkg.status) + '</span>'
			: '';
		const distTag = pkg.distributionType && pkg.distributionType !== 'bundle'
			? '<span class="vs-mp-tag">' + esc(pkg.distributionType) + '</span>'
			: '';
		// 「已安装」页签里可升级的条目 ⇒ 标出来 ✓
		const upgradableTag = pkg.upgradable
			? '<span class="vs-mp-tag warn">可升级 → v' + esc(pkg.latestVersion || '') + '</span>'
			: '';
		const actions = [];
		actions.push('<button class="vs-mp-btn" data-detail="' + esc(pkg.slug) + '">详情</button>');
		if (pkg.upgradable) {
			actions.push('<button class="vs-mp-btn primary" data-upgrade="' + esc(pkg.slug) + '">升级</button>');
		} else if (perm.canPublish !== false) {
			actions.push('<button class="vs-mp-btn primary" data-install="' + esc(pkg.slug) + '">安装</button>');
		}
		if (state.tab === 'installed') {
			actions.push('<button class="vs-mp-btn danger" data-uninstall="' + esc(pkg.slug) + '">卸载</button>');
		}
		// 「管理」页签：审核三件套（通过 / 拒绝下架 / 推荐位）—— 服务端判权，前端不判 ✓
		if (state.tab === 'admin') {
			actions.push('<button class="vs-mp-btn primary" data-review-ok="' + esc(pkg.slug) + '">通过</button>');
			actions.push('<button class="vs-mp-btn danger" data-review-no="' + esc(pkg.slug) + '">拒绝下架</button>');
			actions.push('<button class="vs-mp-btn" data-review-feature="' + esc(pkg.slug) + '">' +
				(pkg.featured ? '取消推荐' : '设为推荐') + '</button>');
		}
		return '' +
			'<div class="vs-mp-card" data-slug="' + esc(pkg.slug) + '">' +
				'<div class="vs-mp-card-head">' +
					'<span class="vs-mp-kindtag">' + esc(KIND_LABEL[pkg.kind] || pkg.kind) + '</span>' +
					statusTag + distTag + upgradableTag +
				'</div>' +
				'<div class="vs-mp-card-title">' + esc(pkg.name) + '</div>' +
				'<div class="vs-mp-card-meta">' + esc(pkg.author || '暂无') + (version ? ' · ' + esc(version) : '') + '</div>' +
				'<div class="vs-mp-card-desc">' + esc(pkg.description || '这个商品暂时还没有填写介绍。') + '</div>' +
				'<div class="vs-mp-card-actions">' + actions.join('') + '</div>' +
			'</div>';
	}

	/** 详情抽屉。 */
	function renderDetail() {
		const d = state.detail;
		if (!d) { return ''; }
		const perm = d.permissions || {};
		const versions = (d.versions || []).map(v => (
			'<li>' + esc(v.version) + (v.isLatest ? ' <span class="vs-mp-tag ok">最新</span>' : '') +
			'<div class="vs-mp-ver-note">' + esc(v.changelog || '') + '</div>' +
			((perm.canDelete !== false)
				? '<button class="vs-mp-link" data-delver="' + esc(v.version) + '">下架此版本</button>'
				: '') +
			'</li>'
		)).join('');
		const buttons = [];
		if (perm.canPublish !== false) {
			buttons.push('<button class="vs-mp-btn primary" data-install="' + esc(d.slug) + '">安装</button>');
		}
		// 编辑元数据（作者或管理员）—— 服务端判权，前端只按 permissions 渲染 ✓
		if (perm.canEdit !== false) {
			buttons.push('<button class="vs-mp-btn" data-openedit="1">编辑信息</button>');
		}
		if (perm.canDelete !== false) {
			buttons.push('<button class="vs-mp-btn danger" data-uninstall="' + esc(d.slug) + '">卸载</button>');
			buttons.push('<button class="vs-mp-btn danger" data-delpkg="' + esc(d.slug) + '">下架整个包</button>');
		}
		return '' +
			'<div class="vs-mp-mask" data-close="1"></div>' +
			'<div class="vs-mp-drawer">' +
				'<div class="vs-mp-drawer-head">' +
					'<div>' +
						'<div class="vs-mp-drawer-title">' + esc(d.name) + '</div>' +
						'<div class="vs-mp-drawer-meta">' + esc(KIND_LABEL[d.kind] || d.kind) +
							' · ' + esc(d.author || '暂无') +
							(d.version ? ' · v' + esc(d.version) : '') + '</div>' +
					'</div>' +
					'<button class="vs-mp-x" data-close="1">×</button>' +
				'</div>' +
				'<div class="vs-mp-drawer-desc">' + esc(d.description || '这个商品暂时还没有填写介绍。') + '</div>' +
				'<div class="vs-mp-drawer-actions">' + buttons.join('') + '</div>' +
				'<div class="vs-mp-drawer-versions"><h4>版本</h4><ul>' + (versions || '<li class="vs-mp-empty">还没有发布版本</li>') + '</ul></div>' +
			'</div>';
	}

	/**
	 * 发布表单（抽屉式）。
	 *
	 * 数据源是 Host 的 `publishables` op（列本机真实存在的 skill/workflow 目录）——
	 * 不让用户手打 id（打错只会得到"本地没有这个资源"，体验差且容易错）✓
	 */
	function renderPublishForm() {
		const p = state.publish;
		if (!p) { return ''; }
		let opts;
		if (p.items.length === 0) {
			opts = '<option value="">（本机没有可发布的 skill / workflow）</option>';
		} else {
			opts = p.items.map(function (it) {
				const value = it.kind + '|' + it.localId + '|' + it.version;
				const label = (KIND_LABEL[it.kind] || it.kind) + ' · ' + it.localId + (it.version ? ' (v' + it.version + ')' : '');
				const selected = p.pick === it.kind + '|' + it.localId ? ' selected' : '';
				return '<option value="' + esc(value) + '"' + selected + '>' + esc(label) + '</option>';
			}).join('');
		}
		return '' +
			'<div class="vs-mp-mask" data-closepublish="1"></div>' +
			'<div class="vs-mp-drawer">' +
				'<div class="vs-mp-drawer-head">' +
					'<div><div class="vs-mp-drawer-title">发布到商城</div>' +
					'<div class="vs-mp-drawer-meta">从本机已装资源打包上传（skill / workflow 由 dsh 侧打包；agent 转 IDE 打包）</div></div>' +
					'<button class="vs-mp-x" data-closepublish="1">×</button>' +
				'</div>' +
				'<div class="vs-mp-form">' +
					'<label>资源</label>' +
					'<select id="vs-mp-pub-pick" class="vs-mp-input">' + opts + '</select>' +
					'<label>版本（语义化版本，如 1.0.0）</label>' +
					'<input id="vs-mp-pub-version" class="vs-mp-input" placeholder="1.0.0" value="' + esc(p.version || '') + '" />' +
					'<label>更新说明（可空）</label>' +
					'<textarea id="vs-mp-pub-changelog" class="vs-mp-input" rows="3" placeholder="这次改了什么">' + esc(p.changelog || '') + '</textarea>' +
					(p.error ? '<div class="vs-mp-msg error">' + esc(p.error) + '</div>' : '') +
					'<div class="vs-mp-drawer-actions">' +
						'<button class="vs-mp-btn primary" data-dopublish="1"' + (p.busy ? ' disabled' : '') + '>' +
							(p.busy ? '发布中…' : '发布') + '</button>' +
						'<button class="vs-mp-btn" data-closepublish="1">取消</button>' +
					'</div>' +
				'</div>' +
			'</div>';
	}

	/**
	 * 编辑元数据表单（作者 / 管理员）。
	 *
	 * 只放**可改**的字段（`kind`/`slug` 是身份，不可改；版本走"发布"）✓
	 */
	function renderEditForm() {
		const e = state.edit;
		if (!e) { return ''; }
		return '' +
			'<div class="vs-mp-mask" data-closeedit="1"></div>' +
			'<div class="vs-mp-drawer">' +
				'<div class="vs-mp-drawer-head">' +
					'<div><div class="vs-mp-drawer-title">编辑「' + esc(e.slug) + '」的信息</div>' +
					'<div class="vs-mp-drawer-meta">类型与标识不可改；版本请用「发布」</div></div>' +
					'<button class="vs-mp-x" data-closeedit="1">×</button>' +
				'</div>' +
				'<div class="vs-mp-form">' +
					'<label>名称</label>' +
					'<input id="vs-mp-edit-name" class="vs-mp-input" value="' + esc(e.name) + '" />' +
					'<label>介绍</label>' +
					'<textarea id="vs-mp-edit-desc" class="vs-mp-input" rows="3">' + esc(e.description) + '</textarea>' +
					'<label>分类</label>' +
					'<input id="vs-mp-edit-category" class="vs-mp-input" value="' + esc(e.category) + '" />' +
					'<label>图标（emoji 或 codicon）</label>' +
					'<input id="vs-mp-edit-icon" class="vs-mp-input" value="' + esc(e.icon) + '" />' +
					'<label>可见性</label>' +
					'<select id="vs-mp-edit-visibility" class="vs-mp-input">' +
						'<option value="public"' + (e.visibility === 'private' ? '' : ' selected') + '>公开</option>' +
						'<option value="private"' + (e.visibility === 'private' ? ' selected' : '') + '>私有（仅自己可见）</option>' +
					'</select>' +
					(e.error ? '<div class="vs-mp-msg error">' + esc(e.error) + '</div>' : '') +
					'<div class="vs-mp-drawer-actions">' +
						'<button class="vs-mp-btn primary" data-doedit="1"' + (e.busy ? ' disabled' : '') + '>' +
							(e.busy ? '保存中…' : '保存') + '</button>' +
						'<button class="vs-mp-btn" data-closeedit="1">取消</button>' +
					'</div>' +
				'</div>' +
			'</div>';
	}

	/** 主渲染。 */
	function render() {
		const msg = state.msg
			? '<div class="vs-mp-msg ' + esc(state.msg.kind) + '">' + esc(state.msg.text) +
				'<button class="vs-mp-x" data-closemsg="1">×</button></div>'
			: '';
		const cards = state.items.map(renderCard).join('');
		const empty = state.items.length === 0
			? '<div class="vs-mp-empty">' + (state.busy ? '正在加载…' : '没有找到匹配的商品。') + '</div>'
			: '<div class="vs-mp-grid">' + cards + '</div>';
		root.innerHTML = '' +
			'<div class="vs-mp-wrap">' +
				'<header class="vs-mp-head">' +
					'<div>' +
						'<h1>商城工作台</h1>' +
						'<p class="vs-mp-sub">Agent / Skill / 工作台 / 工作流 —— 安装、升级、发布与维护</p>' +
					'</div>' +
					'<div class="vs-mp-tools">' +
						'<input id="vs-mp-q" class="vs-mp-input" placeholder="搜索名称 / 介绍 / 标识" value="' + esc(state.q) + '" />' +
						// 排序（服务端原生支持；列表一长，"按热度/按名字"就很必要 ✓）
						'<select id="vs-mp-sort" class="vs-mp-input" title="排序">' +
							'<option value="recent"' + (state.sort === 'recent' ? ' selected' : '') + '>最近更新</option>' +
							'<option value="popular"' + (state.sort === 'popular' ? ' selected' : '') + '>最热</option>' +
							'<option value="name"' + (state.sort === 'name' ? ' selected' : '') + '>按名称</option>' +
						'</select>' +
						'<button class="vs-mp-btn" data-refresh="1">刷新</button>' +
						// ★ 2026-10-22：发布入口（用户要的"可上传"）。skill/workflow 由 dsh 侧自己打包上传；
						//   agent 会转给 IDE 打包（包格式 agent.json 只有 IDE 会组装）✓
						'<button class="vs-mp-btn primary" data-openpublish="1">发布</button>' +
					'</div>' +
				'</header>' +
				msg +
				'<nav class="vs-mp-tabs">' + renderTabs() + '</nav>' +
				'<nav class="vs-mp-kinds">' + renderKindTabs() + '</nav>' +
				renderCategoryChips() +
				'<div class="vs-mp-count">已显示 ' + state.items.length + ' / 共 ' + state.total + ' 个商品' +
					(state.items.length < state.total && state.tab !== 'admin' && state.tab !== 'installed'
						? '　<button class="vs-mp-link" data-more="1">' + (state.busy ? '加载中…' : '加载更多') + '</button>'
						: '') +
				'</div>' +
				empty +
			'</div>' +
			renderDetail() +
			renderPublishForm() +
			renderEditForm();

		bindEvents();
	}

	/** 事件绑定（每次渲染后重绑；用 data-* 属性做事件委托 ⇒ 不用挂 window ✓）。 */
	function bindEvents() {
		const on = (sel, ev, fn) => {
			root.querySelectorAll(sel).forEach(el => el.addEventListener(ev, fn));
		};
		on('[data-tab]', 'click', e => {
			state.tab = e.currentTarget.getAttribute('data-tab');
			state.detail = null;
			state.msg = null;
			load();
		});
		on('[data-kind]', 'click', e => {
			state.kind = e.currentTarget.getAttribute('data-kind');
			// 换类型 ⇒ 分类清单**必须清空**（不同 kind 的分类是两套；留着会出现选了就空列表 ✗）
			state.category = '';
			state.categories = [];
			load();
		});
		on('[data-category]', 'click', e => {
			state.category = e.currentTarget.getAttribute('data-category') || '';
			load();  // 换分类从第一页重来 ✓
		});
		on('[data-refresh]', 'click', () => { state.msg = null; load(); });
		// 加载更多：**追加**下一页（不清空已看到的；换页签/改搜索时从头来 ✓）
		on('[data-more]', 'click', () => { if (!state.busy) { load({ append: true }); } });

		// ── 发布表单（打开发布 op 拿本机可发布资源 → 选 → 发）──────────────
		on('[data-openpublish]', 'click', async () => {
			state.publish = { items: [], pick: '', version: '', changelog: '', busy: true, error: '' };
			render();
			const res = await action('publishables', {});
			const items = (res && res.ok !== false && Array.isArray(res.items)) ? res.items : [];
			state.publish = {
				items: items,
				pick: items.length ? (items[0].kind + '|' + items[0].localId) : '',
				version: items.length ? (items[0].version || '') : '',
				changelog: '',
				busy: false,
				error: (res && res.ok === false) ? String(res.error || '列不出本机资源') : (items.length ? '' : '本机没有可发布的 skill / workflow'),
			};
			render();
		});
		on('[data-closepublish]', 'click', () => { state.publish = null; render(); });
		const pubPick = root.querySelector('#vs-mp-pub-pick');
		if (pubPick && state.publish) {
			pubPick.addEventListener('change', e => {
				const [kind, localId] = String(e.currentTarget.value || '').split('|');
				const hit = state.publish.items.find(it => it.kind === kind && it.localId === localId);
				state.publish.pick = kind + '|' + localId;
				state.publish.version = hit && hit.version ? hit.version : '';
				state.publish.error = '';
				render();
			});
		}
		const pubVer = root.querySelector('#vs-mp-pub-version');
		if (pubVer && state.publish) {
			pubVer.addEventListener('input', e => { state.publish.version = e.currentTarget.value; });
		}
		const pubLog = root.querySelector('#vs-mp-pub-changelog');
		if (pubLog && state.publish) {
			pubLog.addEventListener('input', e => { state.publish.changelog = e.currentTarget.value; });
		}
		on('[data-dopublish]', 'click', async () => {
			const p = state.publish;
			if (!p || !p.pick) { return; }
			const [kind, localId] = p.pick.split('|');
			const version = String(p.version || '').trim();
			if (!version) {
				p.error = '请填版本号（语义化版本，如 1.0.0）';
				render();
				return;
			}
			p.busy = true;
			p.error = '';
			render();
			const res = await action('publish', { kind, localId, slug: localId, version, changelog: p.changelog || '' });
			if (!res || res.ok === false) {
				p.busy = false;
				p.error = String((res && res.error) || '发布失败');
				render();
				return;
			}
			state.publish = null;
			showMsg('已发布 ' + localId + ' v' + (res.version || version), 'ok');
			await load();
		});
		on('[data-closemsg]', 'click', () => { state.msg = null; render(); });
		on('[data-close]', 'click', () => { state.detail = null; render(); });
		on('[data-detail]', 'click', e => { openDetail(e.currentTarget.getAttribute('data-detail')); });
		on('[data-install]', 'click', e => {
			const slug = e.currentTarget.getAttribute('data-install');
			const pkg = state.items.find(p => p.slug === slug) || (state.detail && state.detail.slug === slug ? state.detail : null);
			const kind = pkg ? pkg.kind : 'skill';
			run('install', { kind: kind, slug: slug }, '已安装（部分资源需要重启后才生效）');
		});
		on('[data-upgrade]', 'click', e => {
			const slug = e.currentTarget.getAttribute('data-upgrade');
			const pkg = state.items.find(p => p.slug === slug);
			const kind = pkg ? pkg.kind : 'skill';
			run('upgrade', { kind: kind, slug: slug }, '已升级（部分资源需要重启后才生效）');
		});
		on('[data-uninstall]', 'click', e => {
			const slug = e.currentTarget.getAttribute('data-uninstall');
			// 卸载要带 kind：详情抽屉里有；卡片上（已安装页签）从列表项取 ✓
			const fromDetail = state.detail && state.detail.slug === slug ? state.detail : null;
			const fromList = state.items.find(p => p.slug === slug);
			const kind = (fromDetail && fromDetail.kind) || (fromList && fromList.kind) || 'skill';
			run('uninstall', { kind: kind, slug: slug }, '已卸载');
		});
		// ── 编辑元数据（作者 / 管理员）─────────────────────────────────────
		on('[data-openedit]', 'click', () => {
			const d = state.detail || {};
			state.edit = {
				slug: d.slug || '',
				name: d.name || '',
				description: d.description || '',
				category: d.category || '',
				icon: d.icon || '',
				visibility: d.visibility || 'public',
				busy: false,
				error: '',
			};
			render();
		});
		on('[data-closeedit]', 'click', () => { state.edit = null; render(); });
		on('[data-doedit]', 'click', async () => {
			const e = state.edit;
			if (!e) { return; }
			// 从 DOM 读（三个输入框是**非受控**的，渲染时只给初值 ⇒ 不重渲染，避免打字被吞 ✓）
			const readVal = (id) => {
				const el = root.querySelector(id);
				return el ? String(el.value || '') : '';
			};
			const patch = {
				slug: e.slug,
				name: readVal('#vs-mp-edit-name'),
				description: readVal('#vs-mp-edit-desc'),
				category: readVal('#vs-mp-edit-category'),
				icon: readVal('#vs-mp-edit-icon'),
				visibility: readVal('#vs-mp-edit-visibility') || 'public',
			};
			if (!patch.name.trim()) {
				e.error = '名称不能为空';
				render();
				return;
			}
			e.busy = true;
			e.error = '';
			render();
			const res = await action('updatePackage', patch);
			if (!res || res.ok === false) {
				e.busy = false;
				e.error = String((res && res.error) || '保存失败');
				render();
				return;
			}
			state.edit = null;
			showMsg('已保存', 'ok');
			await load();
			if (state.detail && state.detail.slug === patch.slug) { await openDetail(patch.slug); }
		});

		// ── 管理页签：审核三件套（服务端判 admin，前端只发意图）─────────────
		on('[data-review-ok]', 'click', e => {
			run('reviewStatus', { slug: e.currentTarget.getAttribute('data-review-ok'), status: 'active' }, '已通过审核');
		});
		on('[data-review-no]', 'click', e => {
			run('reviewStatus', { slug: e.currentTarget.getAttribute('data-review-no'), status: 'removed' }, '已拒绝并下架');
		});
		on('[data-review-feature]', 'click', e => {
			const slug = e.currentTarget.getAttribute('data-review-feature');
			const pkg = state.items.find(p => p.slug === slug);
			run('reviewFeature', { slug: slug, featured: !(pkg && pkg.featured) }, pkg && pkg.featured ? '已取消推荐' : '已设为推荐');
		});
		on('[data-delpkg]', 'click', e => {
			const slug = e.currentTarget.getAttribute('data-delpkg');
			const d = state.detail || {};
			run('deletePackage', { kind: d.kind, slug: slug }, '已下架');
		});
		on('[data-delver]', 'click', e => {
			const version = e.currentTarget.getAttribute('data-delver');
			const d = state.detail || {};
			run('deleteVersion', { kind: d.kind, slug: d.slug, version: version }, '已下架该版本');
		});

		const sortSel = root.querySelector('#vs-mp-sort');
		if (sortSel) {
			sortSel.addEventListener('change', e => {
				state.sort = String(e.currentTarget.value || 'recent');
				load();  // 排序变了要从第一页重来 ✓
			});
		}

		const q = root.querySelector('#vs-mp-q');
		if (q) {
			q.addEventListener('keydown', e => {
				if (e.key !== 'Enter') { return; }
				state.q = e.currentTarget.value.trim();
				load();
			});
		}
	}

	// 首屏
	load();
})();
